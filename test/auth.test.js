const { test, before, after } = require("node:test");
const assert = require("node:assert");
const {
  app,
  request,
  sequelize,
  PASSWORD,
  resetDatabase,
  waitForEmail,
  tokenFrom,
  newAgent,
} = require("./helpers");
const { Session, AuditLog, User, EmailToken, Workspace } = require("../models");

const API = "/api/v1/auth";
const EMAIL = "alice@example.com";

before(resetDatabase);
after(() => sequelize.close());

test("register, verify, login, me, logout", async () => {
  const agent = newAgent();
  const registered = await agent
    .post(`${API}/register`)
    .send({ email: ` ${EMAIL.toUpperCase()} `, password: PASSWORD });
  assert.strictEqual(registered.status, 202);

  const text = await waitForEmail(EMAIL, "Verify");
  assert.match(text, /\/verify\?token=/);

  const verified = await agent
    .post(`${API}/verify-email`)
    .send({ token: tokenFrom(text) });
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.body.user.emailVerified, true);
  assert.match(verified.body.user.id, /^usr_/);
  assert.match(verified.body.workspace.id, /^ws_/);
  assert.deepStrictEqual(verified.body.workspace.limits, {
    maxEndpoints: 5,
    maxDestinations: 3,
    maxEventsPerDay: 5000,
    maxEventsPerMonth: 100000,
    maxBodyBytes: 524288,
    retentionDays: 3,
  });
  assert.strictEqual(verified.headers["set-cookie"], undefined);
  assert.strictEqual((await agent.get(`${API}/me`)).status, 401);

  const login = await agent
    .post(`${API}/login`)
    .send({ email: EMAIL, password: PASSWORD });
  assert.match(login.headers["set-cookie"][0], /relay_sid=.*HttpOnly/i);
  assert.match(login.headers["set-cookie"][0], /SameSite=Lax/i);

  const me = await agent.get(`${API}/me`);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.user.email, EMAIL);
  assert.strictEqual(me.body.user.isOperator, false);

  const reused = await newAgent()
    .post(`${API}/verify-email`)
    .send({ token: tokenFrom(text) });
  assert.strictEqual(reused.status, 422);
  assert.strictEqual(reused.body.error.code, "VALIDATION_FAILED");

  assert.strictEqual((await agent.post(`${API}/logout`)).status, 204);
  const after = await agent.get(`${API}/me`);
  assert.strictEqual(after.status, 401);
  assert.strictEqual(after.body.error.code, "UNAUTHENTICATED");
  assert.ok(after.body.error.requestId);
});

test("duplicate register returns 202 and notifies the owner", async () => {
  const res = await newAgent()
    .post(`${API}/register`)
    .send({ email: EMAIL, password: PASSWORD });
  assert.strictEqual(res.status, 202);
  assert.match(
    await waitForEmail(EMAIL, "Sign-up attempt"),
    /tried to sign up/,
  );
  assert.strictEqual(
    await sequelize.models.User.count({ where: { email: EMAIL } }),
    1,
  );
});

test("register validates input", async () => {
  const res = await newAgent()
    .post(`${API}/register`)
    .send({ email: "not-an-email", password: "short" });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  assert.strictEqual(res.body.error.details.length, 2);
});

test("register rejects the tombstone email domain", async () => {
  const res = await newAgent()
    .post(`${API}/register`)
    .send({ email: "deleted-1@deleted.invalid", password: PASSWORD });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  assert.strictEqual(res.body.error.details[0].path, "body.email");
});

test("login: bad credentials give the same 401, good one sets a session", async () => {
  const wrongPassword = await newAgent()
    .post(`${API}/login`)
    .send({ email: EMAIL, password: "wrong-password-1" });
  const unknownEmail = await newAgent()
    .post(`${API}/login`)
    .send({ email: "nobody@example.com", password: "wrong-password-1" });
  for (const res of [wrongPassword, unknownEmail]) {
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.message, "Invalid email or password");
  }
  assert.strictEqual(
    await AuditLog.count({ where: { action: "login.failed" } }),
    2,
  );

  const agent = newAgent();
  const ok = await agent
    .post(`${API}/login`)
    .send({ email: EMAIL, password: PASSWORD });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await agent.get(`${API}/me`)).status, 200);
  assert.strictEqual(await AuditLog.count({ where: { action: "login" } }), 2);
});

test("unverified user can log in, resend issues a working token", async () => {
  const bob = "bob@example.com";
  const agent = newAgent();
  await agent.post(`${API}/register`).send({ email: bob, password: PASSWORD });
  await waitForEmail(bob, "Verify");

  const login = await agent
    .post(`${API}/login`)
    .send({ email: bob, password: PASSWORD });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.user.emailVerified, false);

  const resend = await agent
    .post(`${API}/resend-verification`)
    .send({ email: bob });
  assert.strictEqual(resend.status, 202);
  const verified = await newAgent()
    .post(`${API}/verify-email`)
    .send({ token: tokenFrom(await waitForEmail(bob, "Verify")) });
  assert.strictEqual(verified.body.user.emailVerified, true);
});

test("resend-verification ignores soft-deleted users", async () => {
  const carol = "carol@example.com";
  await newAgent()
    .post(`${API}/register`)
    .send({ email: carol, password: PASSWORD });
  await waitForEmail(carol, "Verify");
  await User.update({ deletedAt: new Date() }, { where: { email: carol } });
  const before = await EmailToken.count();

  const resend = await newAgent()
    .post(`${API}/resend-verification`)
    .send({ email: carol });
  assert.strictEqual(resend.status, 202);
  assert.strictEqual(await EmailToken.count(), before);
});

test("forgot and reset change the password and kill all sessions", async () => {
  const first = newAgent();
  const second = newAgent();
  await first.post(`${API}/login`).send({ email: EMAIL, password: PASSWORD });
  await second.post(`${API}/login`).send({ email: EMAIL, password: PASSWORD });

  const forgot = await newAgent()
    .post(`${API}/forgot-password`)
    .send({ email: EMAIL });
  assert.strictEqual(forgot.status, 202);
  const unknown = await newAgent()
    .post(`${API}/forgot-password`)
    .send({ email: "ghost@example.com" });
  assert.strictEqual(unknown.status, 202);

  const text = await waitForEmail(EMAIL, "Reset");
  assert.match(text, /\/reset-password\?token=/);
  const newPassword = "a-brand-new-password";
  const reset = await newAgent()
    .post(`${API}/reset-password`)
    .send({ token: tokenFrom(text), password: newPassword });
  assert.strictEqual(reset.status, 204);

  assert.strictEqual((await first.get(`${API}/me`)).status, 401);
  assert.strictEqual((await second.get(`${API}/me`)).status, 401);
  assert.strictEqual(
    (
      await newAgent()
        .post(`${API}/login`)
        .send({ email: EMAIL, password: PASSWORD })
    ).status,
    401,
  );
  assert.strictEqual(
    (
      await newAgent()
        .post(`${API}/login`)
        .send({ email: EMAIL, password: newPassword })
    ).status,
    200,
  );
  const resetRows = await AuditLog.findAll({
    where: { action: "password.reset" },
  });
  assert.strictEqual(resetRows.length, 1);
  assert.ok(resetRows[0].workspaceId);

  const replay = await newAgent()
    .post(`${API}/reset-password`)
    .send({ token: tokenFrom(text), password: newPassword });
  assert.strictEqual(replay.status, 422);
});

test("expired session is rejected", async () => {
  const agent = newAgent();
  await agent
    .post(`${API}/login`)
    .send({ email: EMAIL, password: "a-brand-new-password" });
  await Session.update(
    { expiresAt: new Date(Date.now() - 1000) },
    { where: {} },
  );
  assert.strictEqual((await agent.get(`${API}/me`)).status, 401);
});

test("logout needs no active workspace and never fails without a session", async () => {
  const agent = newAgent();
  await agent
    .post(`${API}/login`)
    .send({ email: EMAIL, password: "a-brand-new-password" });
  const user = await User.findOne({ where: { email: EMAIL } });
  const sessions = await Session.count({ where: { userId: user.id } });
  await Workspace.update(
    { status: "suspended" },
    { where: { ownerUserId: user.id } },
  );
  try {
    assert.strictEqual((await agent.get(`${API}/me`)).status, 403);
    const out = await agent.post(`${API}/logout`);
    assert.strictEqual(out.status, 204);
    assert.match(out.headers["set-cookie"].join(";"), /relay_sid=;/);
    assert.strictEqual(
      await Session.count({ where: { userId: user.id } }),
      sessions - 1,
    );
  } finally {
    await Workspace.update(
      { status: "active" },
      { where: { ownerUserId: user.id } },
    );
  }

  const anonymous = await newAgent().post(`${API}/logout`);
  assert.strictEqual(anonymous.status, 204);
  const unknown = await newAgent()
    .post(`${API}/logout`)
    .set("Cookie", "relay_sid=unknown");
  assert.strictEqual(unknown.status, 204);
  assert.match(unknown.headers["set-cookie"].join(";"), /relay_sid=;/);
});

test("cross-origin POST is rejected, same origin allowed", async () => {
  const bad = await newAgent()
    .post(`${API}/forgot-password`)
    .set("Origin", "https://evil.example")
    .send({ email: EMAIL });
  assert.strictEqual(bad.status, 403);
  assert.strictEqual(bad.body.error.code, "FORBIDDEN");

  const good = await newAgent()
    .post(`${API}/forgot-password`)
    .set("Origin", new URL(process.env.APP_BASE_URL).origin)
    .send({ email: EMAIL });
  assert.strictEqual(good.status, 202);
});

test("health endpoints and unknown routes", async () => {
  assert.deepStrictEqual((await request(app.callback()).get("/healthz")).body, {
    ok: true,
  });
  assert.strictEqual(
    (await request(app.callback()).get("/readyz")).status,
    200,
  );
  const missing = await request(app.callback()).get("/api/v1/nope");
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error.code, "NOT_FOUND");
});
