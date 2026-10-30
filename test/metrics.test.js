const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { once } = require("node:events");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { startReceiver } = require("./receiver");
const { Delivery, Destination, Endpoint, Event } = require("../models");
const { processDelivery } = require("../services/delivery");
const metrics = require("../services/metrics");

let agent;
let endpoint;
let receiver;

before(async () => {
  await resetDatabase();
  agent = await signUp("metrics@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "metrics" }))
    .body;
  receiver = await startReceiver();
});

after(async () => {
  await receiver.close();
  await sequelize.close();
});

const captureStdout = async (run) => {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === "string" && /^(level=\[|\{"ts")/.test(chunk))
      lines.push(...chunk.split("\n"));
    else original.call(this, chunk, ...rest);
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return lines;
};

const accessLine = (lines) =>
  lines.find((line) => line.includes("request status="));

const attemptCount = async (outcome) =>
  (await metrics.deliveryAttempts.get()).values.find(
    (value) => value.labels.outcome === outcome,
  )?.value || 0;

test("route labels use the router template, never the ingest slug", async () => {
  await request(app.callback()).get("/healthz");
  const res = await request(app.callback())
    .post(`/h/${endpoint.slug}`)
    .send({ a: 1 });
  assert.strictEqual(res.status, 200);
  const text = await metrics.registry.metrics();
  assert.ok(
    text.includes(
      'relay_http_requests_total{method="POST",route="/h/:slug{/*rest}",status="200"}',
    ),
  );
  assert.ok(text.includes('route="/healthz"'));
  assert.ok(!text.includes(endpoint.slug));
});

test("an unknown path is labeled unmatched", async () => {
  const res = await request(app.callback()).get("/no/such/path");
  assert.strictEqual(res.status, 404);
  const text = await metrics.registry.metrics();
  assert.ok(
    text.includes(
      'relay_http_requests_total{method="GET",route="unmatched",status="404"}',
    ),
  );
});

test("the access line sees the final error status and leaks no secrets", async () => {
  delete process.env.LOG_FORMAT;
  const lines = await captureStdout(() =>
    request(app.callback())
      .get("/api/v1/endpoints?token=secretvalue")
      .set("Authorization", "Bearer secretbearer")
      .set("Cookie", "relay_session=secretcookie"),
  );
  const line = accessLine(lines);
  assert.match(
    line,
    /method=GET url=\/api\/v1\/endpoints msg="request status=401 durationMs=\d+"/,
  );
  for (const secret of ["secretvalue", "secretbearer", "secretcookie"])
    assert.ok(!lines.join("\n").includes(secret));
});

test("health probes write no access line", async () => {
  const lines = await captureStdout(() =>
    request(app.callback()).get("/healthz"),
  );
  assert.strictEqual(accessLine(lines), undefined);
});

test("LOG_FORMAT=json emits one parseable object with a masked slug", async () => {
  process.env.LOG_FORMAT = "json";
  let lines;
  try {
    lines = await captureStdout(() =>
      request(app.callback()).post(`/h/${endpoint.slug}?token=secretvalue`),
    );
  } finally {
    delete process.env.LOG_FORMAT;
  }
  const entry = JSON.parse(accessLine(lines));
  assert.deepStrictEqual(Object.keys(entry), [
    "ts",
    "level",
    "requestId",
    "method",
    "url",
    "msg",
  ]);
  assert.strictEqual(entry.method, "POST");
  assert.strictEqual(entry.url, `/h/${endpoint.slug.slice(0, 6)}...`);
  assert.match(entry.msg, /^request status=200 durationMs=\d+$/);
  assert.ok(!lines.join("\n").includes("secretvalue"));
});

test("a recorded delivery attempt increments relay_delivery_attempts_total", async () => {
  const destination = await Destination.findOne({
    where: {
      publicId: (
        await agent
          .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
          .send({ name: "ok", url: `${receiver.url}/ok` })
      ).body.id,
    },
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
  const delivery = await Delivery.create({
    eventId: event.id,
    destinationId: destination.id,
    trigger: "manual",
    status: "pending",
    nextAttemptAt: new Date(),
  });
  const before = await attemptCount("success");
  await processDelivery(delivery.id);
  assert.strictEqual(await attemptCount("success"), before + 1);
  const text = await metrics.registry.metrics();
  assert.ok(text.includes("relay_delivery_attempt_duration_seconds_count"));
});

test("serve answers /readyz by readiness, /healthz and /metrics", async (t) => {
  let isReady = true;
  const server = metrics.serve(0, async () => isReady);
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await fetch(`${base}/readyz`)).status, 200);
  isReady = false;
  assert.strictEqual((await fetch(`${base}/readyz`)).status, 503);
  assert.strictEqual((await fetch(`${base}/healthz`)).status, 200);
  assert.strictEqual((await fetch(`${base}/other`)).status, 404);
  const res = await fetch(`${base}/metrics`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.ok(
    (await res.text()).includes("relay_process_cpu_user_seconds_total"),
  );
});
