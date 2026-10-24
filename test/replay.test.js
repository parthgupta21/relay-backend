const { test, before, after } = require("node:test");
const assert = require("node:assert");
const IORedis = require("ioredis");
const { Worker } = require("bullmq");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { startReceiver } = require("./receiver");
const { Workspace } = require("../models");
const { processJob } = require("../services/delivery");
const queue = require("../services/queue");

let alice;
let bob;
let endpoint;
let receiver;
let worker;
let workerConnection;
let eventId;
let destinations;
let deliveries;

const waitForSettled = async (id) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const delivery = (await alice.get(`/api/v1/deliveries/${id}`)).body;
    if (["succeeded", "failed"].includes(delivery.status)) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("delivery did not finish");
};

const eventDeliveries = async () =>
  (await alice.get(`/api/v1/events/${eventId}`)).body.deliveries;

before(async () => {
  await resetDatabase();
  alice = await signUp("alice-replay@example.com");
  bob = await signUp("bob-replay@example.com");
  endpoint = (await alice.post("/api/v1/endpoints").send({ name: "r" })).body;
  receiver = await startReceiver();
  destinations = [];
  for (const path of ["/ok", "/ok2"])
    destinations.push(
      (
        await alice
          .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
          .send({ name: path, url: `${receiver.url}${path}` })
      ).body,
    );
  workerConnection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  worker = new Worker(queue.QUEUE_NAME, processJob, {
    connection: workerConnection,
    concurrency: 5,
  });
  await worker.waitUntilReady();
  eventId = (
    await request(app.callback()).post(`/h/${endpoint.slug}`).send("payload")
  ).body.id;
  for (let attempt = 0; attempt < 100; attempt++) {
    deliveries = await eventDeliveries();
    if (
      deliveries.length === 2 &&
      deliveries.every((d) => d.status === "succeeded")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  receiver.requests.length = 0;
});

after(async () => {
  await worker.close();
  workerConnection.disconnect();
  await receiver.close();
  await sequelize.close();
});

const replay = (agent, deliveryId, key) => {
  const req = agent.post(`/api/v1/deliveries/${deliveryId}/replay`);
  return key ? req.set("Idempotency-Key", key) : req;
};

test("replaying a delivery creates a manual delivery that succeeds", async () => {
  const res = await replay(alice, deliveries[0].id, "k-first");
  assert.strictEqual(res.status, 202);
  const { delivery } = res.body;
  assert.match(delivery.id, /^dlv_/);
  assert.notStrictEqual(delivery.id, deliveries[0].id);
  assert.strictEqual(delivery.trigger, "manual");
  assert.strictEqual(delivery.replayOf, deliveries[0].id);
  assert.strictEqual(delivery.destinationId, deliveries[0].destinationId);
  assert.ok(delivery.nextAttemptAt);

  const settled = await waitForSettled(delivery.id);
  assert.strictEqual(settled.status, "succeeded");
  assert.strictEqual(settled.eventId, eventId);
  assert.strictEqual(receiver.requests.length, 1);
});

test("the same key and request replays the stored response without a new delivery", async () => {
  const before = (await eventDeliveries()).length;
  const first = await replay(alice, deliveries[1].id, "k-same");
  const second = await replay(alice, deliveries[1].id, "k-same");
  assert.strictEqual(second.status, 202);
  assert.deepStrictEqual(second.body, first.body);
  assert.strictEqual((await eventDeliveries()).length, before + 1);
  await waitForSettled(first.body.delivery.id);
});

test("the same key with a different request is rejected", async () => {
  await replay(alice, deliveries[0].id, "k-reused");
  const res = await replay(alice, deliveries[1].id, "k-reused");
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.error.code, "IDEMPOTENCY_KEY_REUSED");
});

test("a missing or oversized Idempotency-Key is rejected", async () => {
  for (const key of [undefined, "k".repeat(256)]) {
    const res = await replay(alice, deliveries[0].id, key);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
    assert.strictEqual(
      res.body.error.details[0].path,
      "headers.idempotency-key",
    );
  }
});

test("a replay is refused with 503 while redis is not ready", async () => {
  queue.connection.status = "reconnecting";
  try {
    const res = await replay(alice, deliveries[0].id, "k-redis-down");
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error.code, "SERVICE_UNAVAILABLE");
  } finally {
    queue.connection.status = "ready";
  }
});

test("another workspace gets 404 and the key is not consumed", async () => {
  const res = await replay(bob, deliveries[0].id, "k-bob");
  assert.strictEqual(res.status, 404);
  assert.strictEqual(
    (
      await bob
        .post(`/api/v1/events/${eventId}/replay`)
        .set("Idempotency-Key", "k-bob")
        .send({})
    ).status,
    404,
  );
});

test("an unverified user cannot replay", async () => {
  const carol = await signUp("carol-replay@example.com", { verify: false });
  await carol.post("/api/v1/auth/login").send({
    email: "carol-replay@example.com",
    password: "correct-horse-battery",
  });
  const res = await replay(carol, deliveries[0].id, "k-carol");
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error.code, "EMAIL_NOT_VERIFIED");
});

test("replaying an event reaches every active destination", async () => {
  receiver.requests.length = 0;
  const res = await alice
    .post(`/api/v1/events/${eventId}/replay`)
    .set("Idempotency-Key", "k-event")
    .send({});
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.deliveries.length, 2);
  for (const delivery of res.body.deliveries) {
    assert.strictEqual(delivery.trigger, "manual");
    assert.strictEqual(delivery.replayOf, null);
    assert.strictEqual((await waitForSettled(delivery.id)).status, "succeeded");
  }
  assert.strictEqual(receiver.requests.length, 2);
});

test("event replay can target chosen destinations and rejects foreign ones", async () => {
  receiver.requests.length = 0;
  const chosen = await alice
    .post(`/api/v1/events/${eventId}/replay`)
    .set("Idempotency-Key", "k-chosen")
    .send({ destinationIds: [destinations[1].id] });
  assert.strictEqual(chosen.body.deliveries.length, 1);
  assert.strictEqual(
    chosen.body.deliveries[0].destinationId,
    destinations[1].id,
  );
  await waitForSettled(chosen.body.deliveries[0].id);

  const rejected = await alice
    .post(`/api/v1/events/${eventId}/replay`)
    .set("Idempotency-Key", "k-bad-dst")
    .send({ destinationIds: ["dst_nope"] });
  assert.strictEqual(rejected.status, 422);
  assert.strictEqual(rejected.body.error.code, "VALIDATION_FAILED");
});

test("more than 100 replays an hour gets 429", async () => {
  const workspace = await Workspace.findOne({ order: [["id", "ASC"]] });
  const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, "");
  await queue.connection.set(`replays:${workspace.id}:${hour}`, 100);
  const res = await replay(alice, deliveries[0].id, "k-limit");
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error.code, "QUOTA_EXCEEDED");
  await queue.connection.del(`replays:${workspace.id}:${hour}`);
  assert.strictEqual(
    (await replay(alice, deliveries[0].id, "k-limit")).status,
    202,
  );
});

test("a failed request releases its key", async () => {
  const missing = await replay(alice, "dlv_missing", "k-release");
  assert.strictEqual(missing.status, 404);
  const retry = await replay(alice, deliveries[0].id, "k-release");
  assert.strictEqual(retry.status, 202);
  await waitForSettled(retry.body.delivery.id);
});
