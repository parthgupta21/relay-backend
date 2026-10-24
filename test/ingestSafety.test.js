const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { Delivery } = require("../models");

let agent;
let endpoint;

const send = (slug) => request(app.callback()).post(`/h/${slug}`);

before(async () => {
  await resetDatabase();
  agent = await signUp("ingest-safety@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "safety" }))
    .body;
});
after(() => sequelize.close());

test("event carrying x-relay-delivery-id is stored without deliveries", async () => {
  const created = await agent
    .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
    .send({ name: "fan", url: "http://93.184.216.34/hook" });
  assert.strictEqual(created.status, 201);

  const normal = await send(endpoint.slug).send("a");
  assert.strictEqual(await Delivery.count(), 1);

  const looped = await send(endpoint.slug)
    .set("X-Relay-Delivery-Id", "dlv_loop")
    .send("a");
  assert.strictEqual(looped.status, 200);
  assert.strictEqual(
    (await agent.get(`/api/v1/events/${looped.body.id}`)).status,
    200,
  );
  assert.strictEqual(await Delivery.count(), 1);
  assert.notStrictEqual(looped.body.id, normal.body.id);
});

test("destination pointing at the RELAY ingest host is rejected", async () => {
  const res = await agent
    .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
    .send({
      name: "loop",
      url: `${process.env.HOOKS_BASE_URL}/h/${endpoint.slug}`,
    });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  assert.strictEqual(
    res.body.error.details[0].message,
    "Destination cannot be a RELAY ingest URL",
  );
});

test("stored headers redact credentials and keep the rest", async () => {
  const res = await send(endpoint.slug)
    .set("Authorization", "Bearer secret")
    .set("Proxy-Authorization", "Basic secret")
    .set("Cookie", "sid=secret")
    .set("X-Custom", "kept")
    .send("a");
  const { headers } = (await agent.get(`/api/v1/events/${res.body.id}`)).body;
  assert.strictEqual(headers.authorization, "[redacted]");
  assert.strictEqual(headers["proxy-authorization"], "[redacted]");
  assert.strictEqual(headers.cookie, "[redacted]");
  assert.strictEqual(headers["x-custom"], "kept");
});

test("JSON nested past the database depth limit is stored with bodyJson null", async () => {
  const bodyJsonFor = async (depth) => {
    const res = await send(endpoint.slug)
      .set("Content-Type", "application/json")
      .send("[".repeat(depth) + "]".repeat(depth));
    assert.strictEqual(res.status, 200);
    return (await agent.get(`/api/v1/events/${res.body.id}`)).body.bodyJson;
  };
  assert.notStrictEqual(await bodyJsonFor(100), null);
  assert.strictEqual(await bodyJsonFor(101), null);
  assert.strictEqual(await bodyJsonFor(5000), null);
});
