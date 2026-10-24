const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DelayedError } = require("bullmq");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const { startReceiver } = require("./receiver");
const {
  Delivery,
  Destination,
  Endpoint,
  Event,
  Workspace,
} = require("../models");
const { processDelivery, processJob } = require("../services/delivery");
const { acquire } = require("../services/semaphore");
const queue = require("../services/queue");

process.env.RETRY_BASE_MS = "20";

let agent;
let endpoint;
let receiver;

before(async () => {
  await resetDatabase();
  agent = await signUp("engine@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "eng" })).body;
  receiver = await startReceiver();
});

beforeEach(() => {
  receiver.requests.length = 0;
});

after(async () => {
  await receiver.close();
  await sequelize.close();
});

const makeDelivery = async (path) => {
  for (const existing of (
    await agent.get(`/api/v1/endpoints/${endpoint.id}/destinations`)
  ).body)
    await agent.delete(`/api/v1/destinations/${existing.id}`);
  const created = (
    await agent
      .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
      .send({ name: path, url: `${receiver.url}${path}` })
  ).body;
  const destination = await Destination.findOne({
    where: { publicId: created.id },
  });
  const stored = await Endpoint.findOne({ where: { publicId: endpoint.id } });
  const event = await Event.create({
    endpointId: stored.id,
    method: "POST",
    path: "/",
    headers: {},
    bodySize: 0,
    sourceIp: Buffer.from([127, 0, 0, 1]),
    receivedAt: new Date(),
  });
  return Delivery.create({
    eventId: event.id,
    destinationId: destination.id,
    trigger: "manual",
    status: "pending",
    nextAttemptAt: new Date(),
  });
};

const waitForRequest = async () => {
  const deadline = Date.now() + 5000;
  while (!receiver.requests.length) {
    assert.ok(Date.now() < deadline, "receiver got no request");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const takeJob = async (jobId) => {
  const job = await queue.queue.getJob(jobId);
  await job?.remove();
  return job;
};

test("408 and 429 are retried", async () => {
  for (const status of [408, 429]) {
    const delivery = await makeDelivery(`/status/${status}`);
    await processDelivery(delivery.id);
    await delivery.reload();
    assert.strictEqual(delivery.status, "retry_scheduled");
    assert.strictEqual(delivery.lastStatus, status);
    assert.ok(await takeJob(`d${delivery.id}-a2`));
  }
});

test("a 4xx other than 408 and 429 is not retried", async () => {
  const delivery = await makeDelivery("/status/404");
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "non_retryable");
});

test("Retry-After on 429 and 503 pushes nextAttemptAt out", async () => {
  for (const status of [429, 503]) {
    const delivery = await makeDelivery(`/status/${status}/120`);
    const before = Date.now();
    await processDelivery(delivery.id);
    await delivery.reload();
    assert.strictEqual(delivery.status, "retry_scheduled");
    assert.ok(delivery.nextAttemptAt - before >= 119000);
    assert.ok(await takeJob(`d${delivery.id}-a2`));
  }
});

test("Retry-After is ignored on other retryable statuses", async () => {
  const delivery = await makeDelivery("/status/500/120");
  const before = Date.now();
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.ok(delivery.nextAttemptAt - before < 5000);
  await takeJob(`d${delivery.id}-a2`);
});

test("a response body of 100KB is stored truncated to at most 64KB", async () => {
  const delivery = await makeDelivery("/big");
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "succeeded");
  const [attempt] = await delivery.getAttempts();
  assert.ok(attempt.responseBody.length > 60 * 1024);
  assert.ok(attempt.responseBody.length <= 64 * 1024);
});

test("an inactive destination fails with destination_disabled and no request", async () => {
  const delivery = await makeDelivery("/ok");
  await Destination.update(
    { isActive: false },
    { where: { id: delivery.destinationId } },
  );
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "destination_disabled");
  assert.strictEqual(receiver.requests.length, 0);
  assert.strictEqual(await delivery.countAttempts(), 0);
});

test("a suspended workspace fails with destination_disabled and no request", async () => {
  const delivery = await makeDelivery("/ok");
  await Workspace.update({ status: "suspended" }, { where: {} });
  try {
    await processDelivery(delivery.id);
  } finally {
    await Workspace.update({ status: "active" }, { where: {} });
  }
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "destination_disabled");
  assert.strictEqual(receiver.requests.length, 0);
});

test("a delivery reset mid-flight is not overwritten and not re-enqueued", async () => {
  const delivery = await makeDelivery("/slow-fail");
  const processing = processDelivery(delivery.id);
  await waitForRequest();
  await delivery.update({ status: "retry_scheduled", lockedUntil: null });
  await processing;
  await delivery.reload();
  assert.strictEqual(delivery.status, "retry_scheduled");
  assert.strictEqual(delivery.lastStatus, null);
  assert.strictEqual(await delivery.countAttempts(), 1);
  assert.strictEqual(await takeJob(`d${delivery.id}-a2`), undefined);
});

test("a delivery re-claimed by another worker mid-flight is not overwritten", async () => {
  const delivery = await makeDelivery("/slow-fail");
  const processing = processDelivery(delivery.id);
  await waitForRequest();
  await delivery.update({ attemptCount: 2 });
  await processing;
  await delivery.reload();
  assert.strictEqual(delivery.status, "in_flight");
  assert.strictEqual(delivery.attemptCount, 2);
  assert.strictEqual(delivery.lastStatus, null);
  assert.strictEqual(delivery.completedAt, null);
  assert.strictEqual(await takeJob(`d${delivery.id}-a2`), undefined);
});

test("a job refused by the semaphore is delayed and nothing is sent", async () => {
  process.env.DESTINATION_CONCURRENCY = "1";
  const delivery = await makeDelivery("/ok");
  const destination = await Destination.findByPk(delivery.destinationId);
  const { workspaceId } = await Endpoint.findByPk(destination.endpointId);
  await acquire({ destinationId: destination.id, workspaceId }, "holder");
  const moves = [];
  const job = {
    id: "sem-job",
    data: { deliveryId: delivery.id },
    moveToDelayed: async (...args) => moves.push(args),
  };
  try {
    const before = Date.now();
    await assert.rejects(processJob(job, "tok"), DelayedError);
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0][1], "tok");
    assert.ok(moves[0][0] >= before + 2000 && moves[0][0] <= before + 5100);
    assert.strictEqual(receiver.requests.length, 0);
    await delivery.reload();
    assert.strictEqual(delivery.status, "pending");
    assert.strictEqual(delivery.attemptCount, 0);
  } finally {
    delete process.env.DESTINATION_CONCURRENCY;
    await queue.connection.del(
      `test:sem:dst:${destination.id}`,
      `test:sem:ws:${workspaceId}`,
    );
  }
});
