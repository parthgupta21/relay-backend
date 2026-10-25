process.env.NODE_ENV = "test";
require("dotenv").config({ quiet: true });
const { once } = require("node:events");
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { ApiToken, Workspace } = require("../models");
const queue = require("../services/queue");
const { limitIngest, recordUsage, getUsage } = require("../services/usage");

const DAY_MS = 24 * 60 * 60 * 1000;
const workspace = { id: 9102, maxEventsPerDay: 10, maxEventsPerMonth: 20 };
const endpoint = { id: 9101, workspaceId: workspace.id, workspace };

const stamp = (date = new Date()) => date.toISOString().replace(/\D/g, "");
const dayKey = (kind) => `test:usage:9102:${kind}:${stamp().slice(0, 8)}`;
const monthKey = () => `test:usage:9102:events:${stamp().slice(0, 6)}`;
const failure = (promise) =>
  promise.then(
    () => assert.fail("did not reject"),
    (err) => err,
  );

const clean = async () => {
  const keys = [
    ...(await queue.connection.keys("test:usage:*")),
    ...(await queue.connection.keys("test:rl:ep:9101:*")),
  ];
  if (keys.length) await queue.connection.del(...keys);
};

before(async () => {
  if (queue.connection.status !== "ready")
    await once(queue.connection, "ready");
});
beforeEach(clean);
after(() => sequelize.close());

test("limitIngest passes below the limits", async () => {
  await limitIngest(endpoint);
  const rateKey = `test:rl:ep:9101:${stamp().slice(0, 12)}`;
  assert.strictEqual(await queue.connection.get(rateKey), "1");
  const ttl = await queue.connection.ttl(rateKey);
  assert.ok(ttl > 0 && ttl <= 60);
});

test("limitIngest passes one below each limit", async () => {
  for (const date of [new Date(), new Date(Date.now() + 60000)])
    await queue.connection.set(
      `test:rl:ep:9101:${stamp(date).slice(0, 12)}`,
      599,
    );
  await queue.connection.set(monthKey(), workspace.maxEventsPerMonth - 1);
  await queue.connection.set(dayKey("events"), workspace.maxEventsPerDay - 1);
  await limitIngest(endpoint);
});

test("limitIngest fails open when the redis command fails", async () => {
  queue.connection.multi = () => ({
    incr: () => queue.connection.multi(),
    expire: () => queue.connection.multi(),
    get: () => queue.connection.multi(),
    exec: () => Promise.reject(new Error("Connection is closed")),
  });
  try {
    await limitIngest(endpoint);
  } finally {
    delete queue.connection.multi;
  }
});

test("limitIngest fails open when redis is not ready", async () => {
  const { status } = queue.connection;
  queue.connection.status = "end";
  try {
    await limitIngest(endpoint);
  } finally {
    queue.connection.status = status;
  }
  assert.deepStrictEqual(await queue.connection.keys("test:rl:ep:9101:*"), []);
});

test("rate over the limit is RATE_LIMITED with retryAfter 1 to 60", async () => {
  for (const date of [new Date(), new Date(Date.now() + 60000)])
    await queue.connection.set(
      `test:rl:ep:9101:${stamp(date).slice(0, 12)}`,
      600,
    );
  const err = await failure(limitIngest(endpoint));
  assert.strictEqual(err.code, "RATE_LIMITED");
  assert.strictEqual(err.status, 429);
  assert.ok(err.retryAfter >= 1 && err.retryAfter <= 60);
});

test("month quota is QUOTA_EXCEEDED until the next month", async () => {
  await queue.connection.set(monthKey(), workspace.maxEventsPerMonth);
  const err = await failure(limitIngest(endpoint));
  const now = new Date();
  const expected =
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now) / 1000;
  assert.strictEqual(err.code, "QUOTA_EXCEEDED");
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.message, "Monthly event quota reached");
  assert.ok(Math.abs(err.retryAfter - expected) <= 5);
});

test("day quota is QUOTA_EXCEEDED until the next UTC midnight", async () => {
  await queue.connection.set(dayKey("events"), workspace.maxEventsPerDay);
  const err = await failure(limitIngest(endpoint));
  const expected = (DAY_MS - (Date.now() % DAY_MS)) / 1000;
  assert.strictEqual(err.code, "QUOTA_EXCEEDED");
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.message, "Daily event quota reached");
  assert.ok(Math.abs(err.retryAfter - expected) <= 5);
});

test("recordUsage events counts the day and the month", async () => {
  await recordUsage(workspace.id, "events");
  await recordUsage(workspace.id, "events");
  assert.strictEqual(await queue.connection.get(dayKey("events")), "2");
  assert.strictEqual(await queue.connection.get(monthKey()), "2");
  for (const key of [dayKey("events"), monthKey()])
    assert.ok((await queue.connection.ttl(key)) > 39 * 24 * 60 * 60);
});

test("recordUsage deliveries counts only the day", async () => {
  await recordUsage(workspace.id, "deliveries");
  assert.strictEqual(await queue.connection.get(dayKey("deliveries")), "1");
  assert.deepStrictEqual(await queue.connection.keys("test:usage:9102:*"), [
    dayKey("deliveries"),
  ]);
});

test("getUsage returns the month, today, rate limit and 31 days", async () => {
  await recordUsage(workspace.id, "events");
  await recordUsage(workspace.id, "events");
  await recordUsage(workspace.id, "deliveries");
  const usage = await getUsage(workspace);
  const today = new Date().toISOString().slice(0, 10);
  const start = `${today.slice(0, 7)}-01T00:00:00.000Z`;
  assert.deepStrictEqual(usage.month, {
    start,
    resetsAt: new Date(
      Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 1),
    ).toISOString(),
    events: 2,
    eventsLimit: 20,
    deliveries: 1,
  });
  assert.deepStrictEqual(usage.today, {
    date: today,
    events: 2,
    eventsLimit: 10,
    deliveries: 1,
  });
  assert.deepStrictEqual(usage.rateLimit, { perEndpointPerMinute: 600 });
  assert.strictEqual(usage.days.length, 31);
  assert.deepStrictEqual(usage.days[30], {
    date: today,
    events: 2,
    deliveries: 1,
  });
  assert.deepStrictEqual(usage.days[0], {
    date: new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10),
    events: 0,
    deliveries: 0,
  });
});

test("getUsage is 503 when redis is down", async () => {
  const { status } = queue.connection;
  queue.connection.status = "end";
  try {
    const err = await failure(getUsage(workspace));
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, "SERVICE_UNAVAILABLE");
  } finally {
    queue.connection.status = status;
  }
});

test("getUsage is 503 when the redis command fails", async () => {
  queue.connection.mget = () =>
    Promise.reject(new Error("Connection is closed"));
  try {
    const err = await failure(getUsage(workspace));
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, "SERVICE_UNAVAILABLE");
  } finally {
    delete queue.connection.mget;
  }
});

const API = "/api/v1";
let alice;
let aliceWorkspace;
let bobWorkspace;
let aliceToken;
let bobToken;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const workspaceOf = (email) =>
  Workspace.findOne({
    include: [{ association: "owner", where: { email } }],
  });
const seed = async (id, events, deliveries) => {
  for (let i = 0; i < events; i++) await recordUsage(id, "events");
  for (let i = 0; i < deliveries; i++) await recordUsage(id, "deliveries");
};
const expectedUsage = (
  { maxEventsPerDay, maxEventsPerMonth },
  events,
  deliveries,
) => {
  const days = Array.from({ length: 31 }, (_, i) => ({
    date: new Date(Date.now() - (30 - i) * DAY_MS).toISOString().slice(0, 10),
    events: i === 30 ? events : 0,
    deliveries: i === 30 ? deliveries : 0,
  }));
  const { date } = days[30];
  return {
    month: {
      start: `${date.slice(0, 7)}-01T00:00:00.000Z`,
      resetsAt: new Date(
        Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 1),
      ).toISOString(),
      events,
      eventsLimit: maxEventsPerMonth,
      deliveries,
    },
    today: { date, events, eventsLimit: maxEventsPerDay, deliveries },
    rateLimit: { perEndpointPerMinute: 600 },
    days,
  };
};

before(async () => {
  await resetDatabase();
  alice = await signUp("alice-usage@example.com");
  await signUp("bob-usage@example.com");
  aliceWorkspace = await workspaceOf("alice-usage@example.com");
  bobWorkspace = await workspaceOf("bob-usage@example.com");
  aliceToken = (await ApiToken.issue(aliceWorkspace.id, { name: "a" })).token;
  bobToken = (await ApiToken.issue(bobWorkspace.id, { name: "b" })).token;
});

test("GET /usage without credentials is 401", async () => {
  const res = await request(app.callback()).get(`${API}/usage`);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error.code, "UNAUTHENTICATED");
});

test("GET /usage with a session is zeros on a fresh workspace", async () => {
  const res = await alice.get(`${API}/usage`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, expectedUsage(aliceWorkspace, 0, 0));
});

test("GET /usage with a session returns the seeded counters", async () => {
  await seed(aliceWorkspace.id, 3, 2);
  const res = await alice.get(`${API}/usage`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, expectedUsage(aliceWorkspace, 3, 2));
});

test("GET /usage with an API token returns the same body", async () => {
  await seed(aliceWorkspace.id, 3, 2);
  const res = await request(app.callback())
    .get(`${API}/usage`)
    .set(bearer(aliceToken));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, expectedUsage(aliceWorkspace, 3, 2));
});

test("GET /usage with a token of a suspended workspace is 403", async () => {
  await aliceWorkspace.update({ status: "suspended" });
  const res = await request(app.callback())
    .get(`${API}/usage`)
    .set(bearer(aliceToken));
  await aliceWorkspace.update({ status: "active" });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error.code, "FORBIDDEN");
});

test("GET /usage is 503 SERVICE_UNAVAILABLE when redis is not ready", async () => {
  const { status } = queue.connection;
  queue.connection.status = "end";
  try {
    const res = await alice.get(`${API}/usage`);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error.code, "SERVICE_UNAVAILABLE");
  } finally {
    queue.connection.status = status;
  }
});

test("GET /usage never shows another workspace's counters", async (t) => {
  t.after(clean);
  await seed(aliceWorkspace.id, 3, 2);
  await seed(bobWorkspace.id, 1, 5);
  const res = await request(app.callback())
    .get(`${API}/usage`)
    .set(bearer(bobToken));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, expectedUsage(bobWorkspace, 1, 5));
  assert.deepStrictEqual(
    (await alice.get(`${API}/usage`)).body,
    expectedUsage(aliceWorkspace, 3, 2),
  );
});
