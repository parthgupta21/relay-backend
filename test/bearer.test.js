const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { ApiToken, User, Workspace } = require("../models");

const API = "/api/v1";
const EVIL = "https://evil.example";

let alice;
let bob;
let aliceWorkspace;
let aliceToken;
let bobToken;
let endpoint;
let eventId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const bare = (method, path, token) =>
  request(app.callback())[method](`${API}${path}`).set(bearer(token));

const workspaceOf = (email) =>
  Workspace.findOne({
    include: [{ association: "owner", where: { email } }],
  });

before(async () => {
  await resetDatabase();
  alice = await signUp("alice-bearer@example.com");
  bob = await signUp("bob-bearer@example.com");
  aliceWorkspace = await workspaceOf("alice-bearer@example.com");
  aliceToken = (await ApiToken.issue(aliceWorkspace.id, { name: "a" })).token;
  bobToken = (
    await ApiToken.issue((await workspaceOf("bob-bearer@example.com")).id, {
      name: "b",
    })
  ).token;
  endpoint = (await alice.post(`${API}/endpoints`).send({ name: "e" })).body;
  await alice
    .post(`${API}/endpoints/${endpoint.id}/destinations`)
    .send({ name: "d", url: "http://93.184.216.34/hook" });
  eventId = (
    await request(app.callback()).post(`/h/${endpoint.slug}`).send("payload")
  ).body.id;
});
after(() => sequelize.close());

test("bearer without a cookie lists and creates endpoints, reads events and replays", async () => {
  const list = await bare("get", "/endpoints", aliceToken);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body[0].id, endpoint.id);

  const created = await bare("post", "/endpoints", aliceToken).send({
    name: "via-token",
  });
  assert.strictEqual(created.status, 201);

  const event = await bare("get", `/events/${eventId}`, aliceToken);
  assert.strictEqual(event.status, 200);
  assert.strictEqual(event.body.id, eventId);

  const replay = await bare(
    "post",
    `/events/${eventId}/replay`,
    aliceToken,
  ).set("Idempotency-Key", "bearer-replay");
  assert.strictEqual(replay.status, 202);
  assert.strictEqual(replay.body.deliveries.length, 1);
});

test("bearer wins over a session cookie", async () => {
  const res = await bob.get(`${API}/endpoints`).set(bearer(aliceToken));
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.some((e) => e.id === endpoint.id));
});

test("evil origin is allowed with bearer and no cookie, rejected with a cookie", async () => {
  const allowed = await bare("post", "/endpoints", aliceToken)
    .set("Origin", EVIL)
    .send({ name: "cross-origin" });
  assert.strictEqual(allowed.status, 201);

  const rejected = await alice
    .post(`${API}/endpoints`)
    .set(bearer(aliceToken))
    .set("Origin", EVIL)
    .send({ name: "blocked" });
  assert.strictEqual(rejected.status, 403);
  assert.strictEqual(rejected.body.error.code, "FORBIDDEN");
});

test("garbage, expired and deleted tokens are 401", async () => {
  const expectUnauthenticated = (res) => {
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, "UNAUTHENTICATED");
    assert.strictEqual(res.body.error.message, "Invalid or expired API token");
  };
  expectUnauthenticated(await bare("get", "/endpoints", "rly_garbage"));

  const expired = await ApiToken.issue(aliceWorkspace.id, { name: "old" });
  await expired.apiToken.update({ expiresAt: new Date(Date.now() - 1000) });
  expectUnauthenticated(await bare("get", "/endpoints", expired.token));

  const deleted = await ApiToken.issue(aliceWorkspace.id, { name: "gone" });
  await deleted.apiToken.destroy();
  expectUnauthenticated(await bare("get", "/endpoints", deleted.token));
});

test("a token whose owner is deleted is 401", async () => {
  const { token } = await ApiToken.issue(aliceWorkspace.id, { name: "orphan" });
  await User.update(
    { deletedAt: new Date() },
    { where: { id: aliceWorkspace.ownerUserId } },
  );
  const res = await bare("get", "/endpoints", token);
  await User.update(
    { deletedAt: null },
    { where: { id: aliceWorkspace.ownerUserId } },
  );
  assert.strictEqual(res.status, 401);
});

test("bob's token gets 404 on alice's resources", async () => {
  for (const path of [
    `/endpoints/${endpoint.id}`,
    `/endpoints/${endpoint.id}/events`,
    `/events/${eventId}`,
  ])
    assert.strictEqual((await bare("get", path, bobToken)).status, 404, path);
});

test("lastUsedAt is set after use", async () => {
  const { apiToken, token } = await ApiToken.issue(aliceWorkspace.id, {
    name: "used",
  });
  await apiToken.reload();
  assert.strictEqual(apiToken.lastUsedAt, null);
  await bare("get", "/endpoints", token);
  await apiToken.reload();
  assert.ok(Date.now() - apiToken.lastUsedAt < 10000);
});

test("bearer on /auth/me and /tokens without a cookie is 401", async () => {
  for (const path of ["/auth/me", "/tokens"]) {
    const res = await bare("get", path, aliceToken);
    assert.strictEqual(res.status, 401, path);
    assert.strictEqual(res.body.error.message, "Authentication required");
  }
});

test("a suspended workspace is 403 on both bearer and session", async () => {
  await aliceWorkspace.update({ status: "suspended" });
  const viaBearer = await bare("get", "/endpoints", aliceToken);
  const viaSession = await alice.get(`${API}/endpoints`);
  await aliceWorkspace.update({ status: "active" });
  for (const res of [viaBearer, viaSession]) {
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "FORBIDDEN");
  }
  assert.strictEqual((await bare("get", "/endpoints", aliceToken)).status, 200);
});

test("lastUsedAt is refreshed only after the throttle window", async () => {
  const { apiToken, token } = await ApiToken.issue(aliceWorkspace.id, {
    name: "throttle",
  });
  const recent = new Date(Date.now() - 5000);
  await apiToken.update({ lastUsedAt: recent });
  await bare("get", "/endpoints", token);
  await apiToken.reload();
  assert.strictEqual(apiToken.lastUsedAt.getTime(), recent.getTime());
  await apiToken.update({ lastUsedAt: new Date(Date.now() - 120000) });
  await bare("get", "/endpoints", token);
  await apiToken.reload();
  assert.ok(Date.now() - apiToken.lastUsedAt < 10000);
});

test("/tokens is session-only: bearer cannot write and is ignored beside a cookie", async () => {
  const post = await request(app.callback())
    .post(`${API}/tokens`)
    .set(bearer(aliceToken))
    .send({ name: "x" });
  assert.strictEqual(post.status, 401);
  const del = await bare("delete", "/tokens/tok_none", aliceToken);
  assert.strictEqual(del.status, 401);
  const withCookie = await alice
    .get(`${API}/tokens`)
    .set(bearer("rly_garbage"));
  assert.strictEqual(withCookie.status, 200);
});
