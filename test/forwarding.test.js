const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const IORedis = require("ioredis");
const { Worker } = require("bullmq");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { startReceiver } = require("./receiver");
const { Delivery, Destination, Event } = require("../models");
const { processDelivery, processJob } = require("../services/delivery");
const queue = require("../services/queue");

process.env.RETRY_BASE_MS = "20";

let agent;
let endpoint;
let receiver;
let worker;
let workerConnection;

before(async () => {
  await resetDatabase();
  agent = await signUp("forward@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "fwd" })).body;
  receiver = await startReceiver();
  workerConnection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  worker = new Worker(queue.QUEUE_NAME, processJob, {
    connection: workerConnection,
    concurrency: 5,
  });
  await worker.waitUntilReady();
});

after(async () => {
  await worker.close();
  workerConnection.disconnect();
  await receiver.close();
  await sequelize.close();
});

const createDestination = async (path, extra = {}) =>
  (
    await agent
      .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
      .send({ name: path, url: `${receiver.url}${path}`, ...extra })
  ).body;

const waitForTerminal = async (eventId, count = 1) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { deliveries } = (await agent.get(`/api/v1/events/${eventId}`)).body;
    if (
      deliveries.length === count &&
      deliveries.every((d) => ["succeeded", "failed"].includes(d.status))
    )
      return deliveries;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("deliveries did not finish");
};

const deliveryDetail = async (id) =>
  (await agent.get(`/api/v1/deliveries/${id}`)).body;

const reset = async () => {
  receiver.requests.length = 0;
  for (const destination of (
    await agent.get(`/api/v1/endpoints/${endpoint.id}/destinations`)
  ).body)
    await agent.delete(`/api/v1/destinations/${destination.id}`);
};

const ingest = (body, headers = {}) => {
  const req = request(app.callback()).post(`/h/${endpoint.slug}`);
  for (const [name, value] of Object.entries(headers)) req.set(name, value);
  return req.send(body);
};

test("event is forwarded byte-exact and signed to every destination", async () => {
  await reset();
  const first = await createDestination("/ok");
  const second = await createDestination("/ok2", { timeoutMs: 5000 });
  await agent.patch(`/api/v1/destinations/${second.id}`).send({
    customHeaders: { "X-Custom": "yes", Authorization: "Bearer tenant" },
  });
  const body = Buffer.from([0, 255, 10, 13, 0x7b, 0x22, 0xc3, 0x28, 0x80]);

  const res = await ingest(body, {
    "Content-Type": "application/octet-stream",
    Cookie: "session=secret",
    Authorization: "Bearer inbound",
    Host: "evil.example",
    "Stripe-Signature": "t=1,v1=abc",
  });
  assert.strictEqual(res.status, 200);

  const deliveries = await waitForTerminal(res.body.id, 2);
  assert.ok(deliveries.every((d) => d.status === "succeeded"));
  assert.strictEqual(receiver.requests.length, 2);

  for (const received of receiver.requests) {
    const destination = received.url === "/ok" ? first : second;
    assert.strictEqual(received.method, "POST");
    assert.ok(received.body.equals(body));
    assert.strictEqual(received.headers.cookie, undefined);
    assert.strictEqual(
      received.headers.authorization,
      received.url === "/ok2" ? "Bearer tenant" : undefined,
    );
    assert.notStrictEqual(received.headers.host, "evil.example");
    assert.strictEqual(received.headers["stripe-signature"], "t=1,v1=abc");
    assert.strictEqual(received.headers["x-relay-event-id"], res.body.id);
    assert.strictEqual(received.headers["x-relay-attempt"], "1");
    assert.match(received.headers["x-relay-delivery-id"], /^dlv_/);
    const [t, v1] = received.headers["x-relay-signature"]
      .split(",")
      .map((part) => part.split("=")[1]);
    assert.strictEqual(t, received.headers["x-relay-timestamp"]);
    const expected = crypto
      .createHmac("sha256", destination.signingSecret)
      .update(`${t}.`)
      .update(body)
      .digest("hex");
    assert.strictEqual(v1, expected);
  }
  assert.strictEqual(
    receiver.requests.find((r) => r.url === "/ok2").headers["x-custom"],
    "yes",
  );

  const detail = await deliveryDetail(deliveries[0].id);
  assert.strictEqual(detail.eventId, res.body.id);
  assert.strictEqual(detail.trigger, "auto");
  assert.strictEqual(detail.replayOf, null);
  assert.strictEqual(detail.attemptCount, 1);
  assert.strictEqual(detail.lastStatus, 200);
  assert.ok(detail.completedAt);
  assert.strictEqual(detail.attempts.length, 1);
  assert.strictEqual(detail.attempts[0].outcome, "success");
  assert.strictEqual(detail.attempts[0].responseStatus, 200);
  assert.strictEqual(detail.attempts[0].responseBody, "ok");
  assert.strictEqual(detail.attempts[0].responseHeaders["x-receiver"], "yes");
});

test("a 400 response fails non-retryably with the attempt recorded", async () => {
  await reset();
  await createDestination("/bad");
  const res = await ingest("x");
  const [delivery] = await waitForTerminal(res.body.id);
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "non_retryable");
  assert.strictEqual(delivery.lastStatus, 400);
  const { attempts } = await deliveryDetail(delivery.id);
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].outcome, "http_error");
  assert.strictEqual(attempts[0].responseBody, "bad");
});

test("a 500 then a 200 succeeds on the second attempt", async () => {
  await reset();
  await createDestination("/flaky");
  const res = await ingest("x");
  const [delivery] = await waitForTerminal(res.body.id);
  assert.strictEqual(delivery.status, "succeeded");
  assert.strictEqual(delivery.attemptCount, 2);
  const { attempts } = await deliveryDetail(delivery.id);
  assert.deepStrictEqual(
    attempts.map((a) => [a.attemptNo, a.responseStatus]),
    [
      [1, 500],
      [2, 200],
    ],
  );
  assert.deepStrictEqual(
    receiver.requests.map((r) => r.headers["x-relay-attempt"]),
    ["1", "2"],
  );
});

test("a destination that keeps returning 500 ends exhausted", async () => {
  await reset();
  const destination = await createDestination("/fail");
  await Destination.update(
    { maxAttempts: 2 },
    { where: { publicId: destination.id } },
  );
  const res = await ingest("x");
  const [delivery] = await waitForTerminal(res.body.id);
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "exhausted");
  assert.strictEqual(delivery.attemptCount, 2);
  assert.strictEqual(receiver.requests.length, 2);
});

test("a receiver that hangs past timeoutMs gives outcome timeout", async () => {
  await reset();
  const destination = await createDestination("/hang", { timeoutMs: 1000 });
  await Destination.update(
    { maxAttempts: 1 },
    { where: { publicId: destination.id } },
  );
  const res = await ingest("x");
  const [delivery] = await waitForTerminal(res.body.id);
  assert.strictEqual(delivery.status, "failed");
  const { attempts } = await deliveryDetail(delivery.id);
  assert.strictEqual(attempts[0].outcome, "timeout");
  assert.ok(attempts[0].durationMs >= 1000);
});

test("redirects are not followed", async () => {
  await reset();
  await createDestination("/redirect");
  const res = await ingest("x");
  const [delivery] = await waitForTerminal(res.body.id);
  assert.strictEqual(delivery.lastStatus, 302);
  assert.deepStrictEqual(
    receiver.requests.map((r) => r.url),
    ["/redirect"],
  );
  const { attempts } = await deliveryDetail(delivery.id);
  assert.strictEqual(attempts[0].outcome, "http_error");
});

const manualDelivery = async (path) => {
  await reset();
  const destination = await createDestination(path);
  const event = await ingest("x");
  await waitForTerminal(event.body.id);
  receiver.requests.length = 0;
  const stored = await Destination.findOne({
    where: { publicId: destination.id },
  });
  const dbEvent = await Event.findOne({ where: { publicId: event.body.id } });
  return Delivery.create({
    eventId: dbEvent.id,
    destinationId: stored.id,
    trigger: "manual",
    status: "pending",
    nextAttemptAt: new Date(),
  });
};

test("running the same job twice records one attempt", async () => {
  const delivery = await manualDelivery("/ok");
  await Promise.all([
    processDelivery(delivery.id),
    processDelivery(delivery.id),
  ]);
  await processDelivery(delivery.id);
  assert.strictEqual(receiver.requests.length, 1);
  await delivery.reload();
  assert.strictEqual(delivery.status, "succeeded");
  assert.strictEqual(delivery.attemptCount, 1);
  assert.strictEqual(await delivery.countAttempts(), 1);
});

test("a deleted destination fails with destination_disabled and no attempt", async () => {
  const delivery = await manualDelivery("/ok");
  await agent.delete(
    `/api/v1/destinations/${(await Destination.findByPk(delivery.destinationId)).publicId}`,
  );
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "destination_disabled");
  assert.strictEqual(receiver.requests.length, 0);
  assert.strictEqual(await delivery.countAttempts(), 0);
});

test("a destination that now resolves to a blocked address is not called", async () => {
  const delivery = await manualDelivery("/ok");
  await Destination.update(
    { url: "http://10.0.0.5/hook" },
    { where: { id: delivery.destinationId } },
  );
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "ssrf_blocked");
  const [attempt] = await delivery.getAttempts();
  assert.strictEqual(attempt.outcome, "blocked");
  assert.strictEqual(receiver.requests.length, 0);
});

test("ingest to an endpoint with no destinations creates no deliveries", async () => {
  await reset();
  const res = await ingest("x");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    (await agent.get(`/api/v1/events/${res.body.id}`)).body.deliveries,
    [],
  );
});
