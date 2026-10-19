const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const { Delivery, Destination, Event } = require("../models");
const queue = require("../services/queue");
const { sweep } = require("../services/sweeper");

let destination;
let event;

before(async () => {
  await resetDatabase();
  const agent = await signUp("sweep@example.com");
  const endpoint = (await agent.post("/api/v1/endpoints").send({ name: "s" }))
    .body;
  const created = (
    await agent
      .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
      .send({ name: "d", url: "http://93.184.216.34/hook" })
  ).body;
  destination = await Destination.findOne({ where: { publicId: created.id } });
  event = await Event.create({
    endpointId: (await destination.getEndpoint()).id,
    method: "POST",
    path: "/",
    headers: {},
    bodySize: 0,
    sourceIp: Buffer.from([127, 0, 0, 1]),
    receivedAt: new Date(),
  });
});

after(() => sequelize.close());

const makeDelivery = (fields) =>
  Delivery.create({
    eventId: event.id,
    destinationId: destination.id,
    trigger: "manual",
    ...fields,
  });

const takeJob = async (jobId) => {
  const job = await queue.queue.getJob(jobId);
  await job?.remove();
  return job;
};

test("a pending delivery with an old next_attempt_at is enqueued", async () => {
  const delivery = await makeDelivery({
    status: "pending",
    nextAttemptAt: new Date(Date.now() - 120000),
  });
  assert.strictEqual(await sweep(), 1);
  const job = await takeJob(`d${delivery.id}-a1`);
  assert.strictEqual(job.data.deliveryId, delivery.id);
  await delivery.destroy();
});

test("a recent pending delivery is left alone", async () => {
  const delivery = await makeDelivery({
    status: "pending",
    nextAttemptAt: new Date(),
  });
  assert.strictEqual(await sweep(), 0);
  assert.strictEqual(await takeJob(`d${delivery.id}-a1`), undefined);
  await delivery.destroy();
});

test("a stale in_flight delivery is reset and enqueued for the next attempt", async () => {
  const delivery = await makeDelivery({
    status: "in_flight",
    attemptCount: 1,
    lockedUntil: new Date(Date.now() - 1000),
  });
  assert.strictEqual(await sweep(), 1);
  await delivery.reload();
  assert.strictEqual(delivery.status, "retry_scheduled");
  assert.strictEqual(delivery.lockedUntil, null);
  assert.ok(delivery.nextAttemptAt);
  assert.ok(await takeJob(`d${delivery.id}-a2`));
  await delivery.destroy();
});

test("a stale in_flight delivery out of attempts fails as exhausted", async () => {
  const delivery = await makeDelivery({
    status: "in_flight",
    attemptCount: destination.maxAttempts,
    lockedUntil: new Date(Date.now() - 1000),
  });
  await sweep();
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "exhausted");
  assert.ok(delivery.completedAt);
  assert.strictEqual(
    await takeJob(`d${delivery.id}-a${destination.maxAttempts + 1}`),
    undefined,
  );
  await delivery.destroy();
});

test("an in_flight delivery that is still locked is not touched", async () => {
  const delivery = await makeDelivery({
    status: "in_flight",
    attemptCount: 1,
    lockedUntil: new Date(Date.now() + 60000),
  });
  assert.strictEqual(await sweep(), 0);
  await delivery.destroy();
});
