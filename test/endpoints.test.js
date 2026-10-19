const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const { Workspace } = require("../models");

const API = "/api/v1/endpoints";

before(resetDatabase);
after(() => sequelize.close());

test("unverified user gets 403 on POST /endpoints, can still list", async () => {
  const agent = await signUp("unverified@example.com", { verify: false });
  await agent.post("/api/v1/auth/login").send({
    email: "unverified@example.com",
    password: "correct-horse-battery",
  });
  const res = await agent.post(API).send({ name: "x" });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error.code, "EMAIL_NOT_VERIFIED");
  assert.strictEqual((await agent.get(API)).status, 200);
});

test("endpoint CRUD", async () => {
  const agent = await signUp("crud@example.com");
  const created = await agent
    .post(API)
    .send({ name: "Stripe", idempotencyHeader: "Idempotency-Key", extra: 1 });
  assert.strictEqual(created.status, 201);
  const endpoint = created.body;
  assert.match(endpoint.id, /^ep_/);
  assert.match(endpoint.slug, /^[0-9A-Za-z]{24}$/);
  assert.strictEqual(
    endpoint.url,
    `${process.env.HOOKS_BASE_URL}/h/${endpoint.slug}`,
  );
  assert.strictEqual(endpoint.idempotencyHeader, "idempotency-key");
  assert.strictEqual(endpoint.isActive, true);
  assert.strictEqual(endpoint.eventCount24h, 0);
  assert.deepStrictEqual(Object.keys(endpoint).sort(), [
    "createdAt",
    "eventCount24h",
    "id",
    "idempotencyHeader",
    "isActive",
    "name",
    "slug",
    "url",
  ]);

  const patched = await agent
    .patch(`${API}/${endpoint.id}`)
    .send({ name: "Renamed", isActive: false, idempotencyHeader: null });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.name, "Renamed");
  assert.strictEqual(patched.body.isActive, false);
  assert.strictEqual(patched.body.idempotencyHeader, null);

  const rotated = await agent.post(`${API}/${endpoint.id}/rotate-slug`);
  assert.strictEqual(rotated.status, 200);
  assert.notStrictEqual(rotated.body.slug, endpoint.slug);
  assert.strictEqual(
    (await agent.get(`${API}/${endpoint.id}`)).body.slug,
    rotated.body.slug,
  );

  const second = await agent.post(API).send({ name: "Second" });
  const list = await agent.get(API);
  assert.deepStrictEqual(
    list.body.map((e) => e.id),
    [second.body.id, endpoint.id],
  );

  assert.strictEqual((await agent.delete(`${API}/${endpoint.id}`)).status, 204);
  assert.strictEqual((await agent.get(`${API}/${endpoint.id}`)).status, 404);
});

test("validation errors", async () => {
  const agent = await signUp("validation@example.com");
  for (const body of [{}, { name: "" }, { name: "a".repeat(101) }]) {
    const res = await agent.post(API).send(body);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  }
});

test("endpoint quota is enforced", async () => {
  const agent = await signUp("quota@example.com");
  await Workspace.update({ maxEndpoints: 2 }, { where: {} });
  assert.strictEqual((await agent.post(API).send({ name: "1" })).status, 201);
  assert.strictEqual((await agent.post(API).send({ name: "2" })).status, 201);
  const res = await agent.post(API).send({ name: "3" });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.error.code, "QUOTA_EXCEEDED");
});
