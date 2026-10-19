const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const { Destination } = require("../models");

const URL_OK = "http://93.184.216.34/hook";

let agent;
let endpoint;

before(async () => {
  await resetDatabase();
  agent = await signUp("dest@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "e" })).body;
});
after(() => sequelize.close());

const list = () => agent.get(`/api/v1/endpoints/${endpoint.id}/destinations`);
const create = (body) =>
  agent.post(`/api/v1/endpoints/${endpoint.id}/destinations`).send(body);

test("destination CRUD, secret only on create and rotate", async () => {
  const created = await create({
    name: "primary",
    url: URL_OK,
    customHeaders: { "X-Token": "abc" },
    timeoutMs: 5000,
  });
  assert.strictEqual(created.status, 201);
  const { signingSecret, ...destination } = created.body;
  assert.match(destination.id, /^dst_/);
  assert.match(signingSecret, /^whsec_[\w-]{43}$/);
  assert.deepStrictEqual(
    { ...destination, id: undefined, createdAt: undefined },
    {
      id: undefined,
      name: "primary",
      url: URL_OK,
      customHeaders: { "X-Token": "abc" },
      timeoutMs: 5000,
      maxAttempts: 8,
      isActive: true,
      createdAt: undefined,
    },
  );

  const stored = await Destination.findOne({
    where: { publicId: destination.id },
  });
  assert.ok(!stored.signingSecret.includes(signingSecret));
  assert.strictEqual(stored.decryptSecret(), signingSecret);

  const listed = await list();
  assert.strictEqual(listed.body.length, 1);
  assert.strictEqual(listed.body[0].signingSecret, undefined);

  const patched = await agent
    .patch(`/api/v1/destinations/${destination.id}`)
    .send({ name: "renamed", isActive: false, timeoutMs: 2000 });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.body.name, "renamed");
  assert.strictEqual(patched.body.isActive, false);
  assert.strictEqual(patched.body.signingSecret, undefined);

  const rotated = await agent.post(
    `/api/v1/destinations/${destination.id}/rotate-secret`,
  );
  assert.strictEqual(rotated.status, 200);
  assert.strictEqual(rotated.body.id, destination.id);
  assert.notStrictEqual(rotated.body.signingSecret, signingSecret);
  await stored.reload();
  assert.strictEqual(stored.decryptSecret(), rotated.body.signingSecret);

  const deleted = await agent.delete(`/api/v1/destinations/${destination.id}`);
  assert.strictEqual(deleted.status, 204);
  assert.deepStrictEqual((await list()).body, []);
  const gone = await agent
    .patch(`/api/v1/destinations/${destination.id}`)
    .send({ name: "x" });
  assert.strictEqual(gone.status, 404);
  assert.ok(
    await Destination.findOne({
      where: { publicId: destination.id },
      paranoid: false,
    }),
  );
});

test("validation and SSRF rejection on create", async () => {
  assert.strictEqual((await create({ name: "x" })).status, 422);
  assert.strictEqual(
    (await create({ name: "x", url: URL_OK, timeoutMs: 500 })).status,
    422,
  );
  const blocked = await create({
    name: "x",
    url: "http://169.254.169.254/latest",
  });
  assert.strictEqual(blocked.status, 422);
  assert.strictEqual(blocked.body.error.code, "VALIDATION_FAILED");
  assert.strictEqual(
    blocked.body.error.message,
    "Destination URL is not allowed",
  );
  assert.deepStrictEqual(blocked.body.error.details[0].path, ["url"]);
  const unresolvable = await create({
    name: "x",
    url: "http://nonexistent.invalid/",
  });
  assert.strictEqual(unresolvable.status, 422);
  assert.strictEqual(
    unresolvable.body.error.message,
    "Destination URL is not allowed",
  );
});

test("SSRF re-check on patch only when url changes", async () => {
  const { body } = await create({ name: "p", url: URL_OK });
  const bad = await agent
    .patch(`/api/v1/destinations/${body.id}`)
    .send({ url: "http://10.0.0.5/" });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.body.error.message, "Destination URL is not allowed");
  const good = await agent
    .patch(`/api/v1/destinations/${body.id}`)
    .send({ url: "http://93.184.216.34:8080/other" });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.body.url, "http://93.184.216.34:8080/other");
});

test("quota counts non-deleted destinations per endpoint", async () => {
  assert.strictEqual(
    (await create({ name: "second", url: URL_OK })).status,
    201,
  );
  assert.strictEqual(
    (await create({ name: "third", url: URL_OK })).status,
    201,
  );
  const over = await create({ name: "fourth", url: URL_OK });
  assert.strictEqual(over.status, 422);
  assert.strictEqual(over.body.error.code, "QUOTA_EXCEEDED");
});

test("unverified user gets 403 on create", async () => {
  const unverified = await signUp("unverified-dest@example.com", {
    verify: false,
  });
  await unverified.post("/api/v1/auth/login").send({
    email: "unverified-dest@example.com",
    password: "correct-horse-battery",
  });
  const blocked = await unverified
    .post("/api/v1/endpoints/ep_any/destinations")
    .send({ name: "x", url: URL_OK });
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.body.error.code, "EMAIL_NOT_VERIFIED");
});
