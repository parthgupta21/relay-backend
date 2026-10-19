const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { Workspace, Endpoint } = require("../models");

let agent;
let endpoint;

const hook = () => request(app.callback());
const send = (slug, suffix = "") => hook().post(`/h/${slug}${suffix}`);

before(async () => {
  await resetDatabase();
  agent = await signUp("ingest@example.com");
  endpoint = (
    await agent
      .post("/api/v1/endpoints")
      .send({ name: "ingest", idempotencyHeader: "x-delivery-id" })
  ).body;
});
after(() => sequelize.close());

test("binary body is stored byte-exact and downloadable", async () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]),
    crypto.randomBytes(2000),
  ]);
  const res = await send(endpoint.slug)
    .set("Content-Type", "application/octet-stream")
    .send(bytes);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.duplicate, false);
  assert.match(res.body.id, /^evt_/);

  const download = await agent
    .get(`/api/v1/events/${res.body.id}/body`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.strictEqual(download.status, 200);
  assert.ok(Buffer.compare(download.body, bytes) === 0);
  assert.strictEqual(
    download.headers["content-type"],
    "application/octet-stream",
  );
  assert.strictEqual(
    download.headers["content-disposition"],
    `attachment; filename="${res.body.id}.bin"`,
  );
  assert.strictEqual(download.headers["x-content-type-options"], "nosniff");

  const detail = await agent.get(`/api/v1/events/${res.body.id}`);
  assert.strictEqual(detail.body.body, bytes.toString("base64"));
  assert.strictEqual(detail.body.bodyJson, null);
  assert.strictEqual(detail.body.bodySize, bytes.length);
});

test("JSON body sets bodyJson; invalid JSON does not", async () => {
  const ok = await send(endpoint.slug)
    .set("Content-Type", "application/json")
    .send('{"a":1,"b":[true]}');
  const detail = await agent.get(`/api/v1/events/${ok.body.id}`);
  assert.deepStrictEqual(detail.body.bodyJson, { a: 1, b: [true] });

  const bad = await send(endpoint.slug)
    .set("Content-Type", "application/json")
    .send("{not json");
  assert.strictEqual(bad.status, 200);
  const badDetail = await agent.get(`/api/v1/events/${bad.body.id}`);
  assert.strictEqual(badDetail.body.bodyJson, null);
  assert.strictEqual(
    badDetail.body.body,
    Buffer.from("{not json").toString("base64"),
  );
});

test("path, query, method, headers and source ip are captured", async () => {
  const res = await hook()
    .put(`/h/${endpoint.slug}/stripe/v1?x=1&y=a%20b`)
    .set("X-Custom", "yes")
    .send("hi");
  const detail = (await agent.get(`/api/v1/events/${res.body.id}`)).body;
  assert.strictEqual(detail.method, "PUT");
  assert.strictEqual(detail.path, "/stripe/v1");
  assert.strictEqual(detail.queryString, "x=1&y=a%20b");
  assert.strictEqual(detail.headers["x-custom"], "yes");
  assert.match(detail.sourceIp, /^127\.0\.0\.1$|^::1$/);
  assert.strictEqual(detail.endpointId, endpoint.id);

  const bare = await hook().get(`/h/${endpoint.slug}`);
  const bareDetail = (await agent.get(`/api/v1/events/${bare.body.id}`)).body;
  assert.strictEqual(bareDetail.path, "/");
  assert.strictEqual(bareDetail.queryString, null);
  assert.strictEqual(bareDetail.body, null);
  assert.strictEqual(bareDetail.bodySize, 0);

  const slash = await hook().get(`/h/${endpoint.slug}/`);
  assert.strictEqual(slash.status, 200);
});

test("404 for unknown slug, disabled endpoint and suspended workspace, storing nothing", async () => {
  const before = await sequelize.models.Event.count();
  assert.strictEqual((await send("nope".repeat(6)).send("x")).status, 404);

  await agent
    .patch(`/api/v1/endpoints/${endpoint.id}`)
    .send({ isActive: false });
  const disabled = await send(endpoint.slug).send("x");
  assert.strictEqual(disabled.status, 404);
  assert.strictEqual(disabled.body.error.code, "NOT_FOUND");
  await agent
    .patch(`/api/v1/endpoints/${endpoint.id}`)
    .send({ isActive: true });

  await Workspace.update({ status: "suspended" }, { where: {} });
  assert.strictEqual((await send(endpoint.slug).send("x")).status, 404);
  await Workspace.update({ status: "active" }, { where: {} });

  assert.strictEqual(await sequelize.models.Event.count(), before);
  assert.strictEqual((await send(endpoint.slug).send("x")).status, 200);
});

test("body over the workspace limit gets 413 and is not stored", async () => {
  await Workspace.update({ maxBodyBytes: 100 }, { where: {} });
  const before = await sequelize.models.Event.count();
  const res = await send(endpoint.slug).send(Buffer.alloc(101, 1));
  assert.strictEqual(res.status, 413);
  assert.strictEqual(res.body.error.code, "PAYLOAD_TOO_LARGE");
  const server = app.listen(0);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        port: server.address().port,
        path: `/h/${endpoint.slug}`,
        method: "POST",
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.write(Buffer.alloc(60, 1));
    req.end(Buffer.alloc(60, 1));
  });
  server.close();
  assert.strictEqual(chunkedStatus, 413);
  assert.strictEqual(await sequelize.models.Event.count(), before);
  assert.strictEqual(
    (await send(endpoint.slug).send(Buffer.alloc(100, 1))).status,
    200,
  );
  await Workspace.update({ maxBodyBytes: 524288 }, { where: {} });
});

test("idempotency header returns the existing event id", async () => {
  const first = await send(endpoint.slug).set("X-Delivery-Id", "d-1").send("a");
  const again = await send(endpoint.slug).set("X-Delivery-Id", "d-1").send("b");
  assert.strictEqual(first.body.duplicate, false);
  assert.deepStrictEqual(again.body, { id: first.body.id, duplicate: true });
  const other = await send(endpoint.slug).set("X-Delivery-Id", "d-2").send("a");
  assert.notStrictEqual(other.body.id, first.body.id);
  const none = await send(endpoint.slug).send("a");
  const none2 = await send(endpoint.slug).send("a");
  assert.notStrictEqual(none.body.id, none2.body.id);
});

test("rotated slug stops the old url and eventCount24h counts events", async () => {
  const rotated = await agent.post(
    `/api/v1/endpoints/${endpoint.id}/rotate-slug`,
  );
  assert.strictEqual((await send(endpoint.slug).send("x")).status, 404);
  assert.strictEqual((await send(rotated.body.slug).send("x")).status, 200);
  const count = await sequelize.models.Event.count();
  assert.strictEqual(rotated.body.eventCount24h, count - 1);
  assert.ok(await Endpoint.findOne({ where: { slug: rotated.body.slug } }));
});
