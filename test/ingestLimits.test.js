const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { startReceiver } = require("./receiver");
const {
  Delivery,
  Destination,
  Endpoint,
  Event,
  Workspace,
} = require("../models");
const { processDelivery } = require("../services/delivery");
const queue = require("../services/queue");

let agent;
let endpoint;
let stored;
let workspace;
let receiver;

const stamp = (date = new Date()) => date.toISOString().replace(/\D/g, "");
const dayKey = (kind) =>
  `test:usage:${workspace.id}:${kind}:${stamp().slice(0, 8)}`;
const monthKey = () =>
  `test:usage:${workspace.id}:events:${stamp().slice(0, 6)}`;
const count = async (key) => Number(await queue.connection.get(key));
const send = (suffix = "") =>
  request(app.callback()).post(`/h/${endpoint.slug}${suffix}`);

const clean = async () => {
  const keys = [
    ...(await queue.connection.keys("test:usage:*")),
    ...(await queue.connection.keys("test:rl:ep:*")),
  ];
  if (keys.length) await queue.connection.del(...keys);
};

before(async () => {
  await resetDatabase();
  agent = await signUp("limits@example.com");
  endpoint = (
    await agent
      .post("/api/v1/endpoints")
      .send({ name: "limits", idempotencyHeader: "x-delivery-id" })
  ).body;
  stored = await Endpoint.findOne({ where: { publicId: endpoint.id } });
  workspace = await Workspace.findOne();
  receiver = await startReceiver();
});
beforeEach(clean);
after(async () => {
  await receiver.close();
  await sequelize.close();
});

test("rate over the limit gets 429 RATE_LIMITED with Retry-After and stores nothing", async () => {
  for (const date of [new Date(), new Date(Date.now() + 60000)])
    await queue.connection.set(
      `test:rl:ep:${stored.id}:${stamp(date).slice(0, 12)}`,
      600,
    );
  const before = await Event.count();
  const res = await send().send("x");
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error.code, "RATE_LIMITED");
  assert.ok(
    res.headers["retry-after"] >= 1 && res.headers["retry-after"] <= 60,
  );
  assert.strictEqual(await Event.count(), before);
});

test("day quota reached gets 429 QUOTA_EXCEEDED with Retry-After and stores nothing", async () => {
  await queue.connection.set(dayKey("events"), workspace.maxEventsPerDay);
  const before = await Event.count();
  const res = await send().send("x");
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error.code, "QUOTA_EXCEEDED");
  assert.ok(Number(res.headers["retry-after"]) > 0);
  assert.strictEqual(await Event.count(), before);
  assert.strictEqual(await count(dayKey("events")), workspace.maxEventsPerDay);
});

test("month quota reached gets 429 QUOTA_EXCEEDED with Retry-After and stores nothing", async () => {
  await queue.connection.set(monthKey(), workspace.maxEventsPerMonth);
  const before = await Event.count();
  const res = await send().send("x");
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error.code, "QUOTA_EXCEEDED");
  assert.ok(Number(res.headers["retry-after"]) > 0);
  assert.strictEqual(await Event.count(), before);
  assert.strictEqual(await count(monthKey()), workspace.maxEventsPerMonth);
});

test("a stored event increments the day and month events counters", async () => {
  assert.strictEqual((await send().send("x")).status, 200);
  assert.strictEqual(await count(dayKey("events")), 1);
  assert.strictEqual(await count(monthKey()), 1);
  assert.strictEqual(
    (await send().set("X-Relay-Delivery-Id", "loop").send("x")).status,
    200,
  );
  assert.strictEqual(await count(dayKey("events")), 2);
  assert.strictEqual(await count(monthKey()), 2);
});

test("a duplicate or failed ingest does not increment", async () => {
  await send().set("X-Delivery-Id", "once").send("a");
  assert.strictEqual(await count(dayKey("events")), 1);
  const again = await send().set("X-Delivery-Id", "once").send("a");
  assert.strictEqual(again.body.duplicate, true);
  await Workspace.update({ maxBodyBytes: 1 }, { where: {} });
  const tooLarge = await send().send("too large");
  await Workspace.update({ maxBodyBytes: 524288 }, { where: {} });
  assert.strictEqual(tooLarge.status, 413);
  assert.strictEqual(await count(dayKey("events")), 1);
  assert.strictEqual(await count(monthKey()), 1);
});

test("another endpoint is not limited", async () => {
  const other = (await agent.post("/api/v1/endpoints").send({ name: "other" }))
    .body;
  for (const date of [new Date(), new Date(Date.now() + 60000)])
    await queue.connection.set(
      `test:rl:ep:${stored.id}:${stamp(date).slice(0, 12)}`,
      600,
    );
  const limited = await send().send("x");
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.body.error.code, "RATE_LIMITED");
  assert.strictEqual(
    (await request(app.callback()).post(`/h/${other.slug}`).send("x")).status,
    200,
  );
});

test("another workspace is unaffected by a month quota", async () => {
  const bob = await signUp("bob@example.com");
  const bobEndpoint = (
    await bob.post("/api/v1/endpoints").send({ name: "bob" })
  ).body;
  const bobWorkspace = (await Workspace.findAll()).find(
    (candidate) => candidate.id !== workspace.id,
  );
  await queue.connection.set(monthKey(), workspace.maxEventsPerMonth);
  const limited = await send().send("x");
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.body.error.code, "QUOTA_EXCEEDED");
  assert.strictEqual(
    (await request(app.callback()).post(`/h/${bobEndpoint.slug}`).send("x"))
      .status,
    200,
  );
  for (const period of [stamp().slice(0, 8), stamp().slice(0, 6)])
    assert.strictEqual(
      await count(`test:usage:${bobWorkspace.id}:events:${period}`),
      1,
    );
});

test("a settled delivery increments the day deliveries counter", async (t) => {
  t.after(clean);
  const created = (
    await agent
      .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
      .send({ name: "ok", url: `${receiver.url}/status/200` })
  ).body;
  const event = await Event.create({
    endpointId: stored.id,
    method: "POST",
    path: "/",
    headers: {},
    bodySize: 0,
    sourceIp: Buffer.from([127, 0, 0, 1]),
    receivedAt: new Date(),
  });
  const delivery = await Delivery.create({
    eventId: event.id,
    destinationId: (
      await Destination.findOne({ where: { publicId: created.id } })
    ).id,
    trigger: "manual",
    status: "pending",
    nextAttemptAt: new Date(),
  });
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "succeeded");
  assert.strictEqual(await count(dayKey("deliveries")), 1);
});
