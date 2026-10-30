const { once } = require("node:events");
const { test, before, beforeEach, after, mock } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const queue = require("../services/queue");

const API = "/api/v1";

const login = (headers = {}) =>
  request(app.callback())
    .post(`${API}/auth/login`)
    .set(headers)
    .send({ email: "nobody@example.com", password: "wrong-password" });

const limitTo = (t, name, value) => {
  const original = process.env[name];
  process.env[name] = value;
  t.after(() => {
    process.env[name] = original;
  });
};

const freezeClock = (t) => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
};

const clean = async () => {
  const keys = [
    ...(await queue.connection.keys("test:rl:auth:*")),
    ...(await queue.connection.keys("test:rl:account-delete:*")),
  ];
  if (keys.length) await queue.connection.del(...keys);
};

before(async () => {
  if (queue.connection.status !== "ready")
    await once(queue.connection, "ready");
  await resetDatabase();
});
beforeEach(clean);
after(() => sequelize.close());

test("the request over AUTH_RATE_PER_MINUTE is 429 RATE_LIMITED with Retry-After", async (t) => {
  limitTo(t, "AUTH_RATE_PER_MINUTE", "3");
  freezeClock(t);
  for (let i = 0; i < 3; i++) assert.strictEqual((await login()).status, 401);
  const res = await login();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error.code, "RATE_LIMITED");
  assert.strictEqual(
    Number(res.headers["retry-after"]),
    60 - new Date().getUTCSeconds(),
  );
});

test("a malformed body also counts toward the limit", async (t) => {
  limitTo(t, "AUTH_RATE_PER_MINUTE", "1");
  freezeClock(t);
  const bad = () =>
    request(app.callback()).post(`${API}/auth/register`).send({});
  assert.strictEqual((await bad()).status, 422);
  assert.strictEqual((await bad()).status, 429);
});

test("logout is not limited", async (t) => {
  limitTo(t, "AUTH_RATE_PER_MINUTE", "1");
  freezeClock(t);
  for (let i = 0; i < 3; i++)
    assert.strictEqual(
      (await request(app.callback()).post(`${API}/auth/logout`)).status,
      204,
    );
});

test("a different client IP behind a trusted proxy is not limited", async (t) => {
  limitTo(t, "AUTH_RATE_PER_MINUTE", "1");
  freezeClock(t);
  const { proxy } = app;
  app.proxy = true;
  t.after(() => {
    app.proxy = proxy;
  });
  const first = { "X-Forwarded-For": "203.0.113.1" };
  assert.strictEqual((await login(first)).status, 401);
  assert.strictEqual((await login(first)).status, 429);
  assert.strictEqual(
    (await login({ "X-Forwarded-For": "203.0.113.2" })).status,
    401,
  );
});

test("a redis command failure fails open", async (t) => {
  limitTo(t, "AUTH_RATE_PER_MINUTE", "1");
  queue.connection.multi = () => ({
    incr: () => queue.connection.multi(),
    expire: () => queue.connection.multi(),
    exec: () => Promise.reject(new Error("Connection is closed")),
  });
  t.after(() => {
    delete queue.connection.multi;
  });
  for (let i = 0; i < 3; i++) assert.strictEqual((await login()).status, 401);
});

test("account delete is limited by ACCOUNT_DELETE_RATE_PER_MINUTE", async (t) => {
  t.after(clean);
  const agent = await signUp("delete-limit@example.com");
  limitTo(t, "ACCOUNT_DELETE_RATE_PER_MINUTE", "2");
  freezeClock(t);
  const attempt = () =>
    agent.post(`${API}/account/delete`).send({ password: "wrong-password" });
  assert.strictEqual((await attempt()).status, 422);
  assert.strictEqual((await attempt()).status, 422);
  const res = await attempt();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error.code, "RATE_LIMITED");
  assert.ok(
    res.headers["retry-after"] >= 1 && res.headers["retry-after"] <= 60,
  );
});
