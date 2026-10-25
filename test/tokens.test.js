const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { ApiToken, AuditLog, Workspace } = require("../models");

let alice;
let bob;

before(async () => {
  await resetDatabase();
  alice = await signUp("alice-tokens@example.com");
  bob = await signUp("bob-tokens@example.com");
});
after(() => sequelize.close());

const ownerWorkspace = (email) =>
  Workspace.findOne({
    include: [{ association: "owner", where: { email } }],
  });
const create = (agent, body) => agent.post("/api/v1/tokens").send(body);

test("create returns the token once, list never does", async () => {
  const created = await create(alice, { name: "  ci  " });
  assert.strictEqual(created.status, 201);
  const { token, ...apiToken } = created.body;
  assert.match(token, /^rly_[\w-]{43}$/);
  assert.match(apiToken.id, /^tok_/);
  assert.strictEqual(apiToken.name, "ci");
  assert.strictEqual(apiToken.prefix, token.slice(0, 12));
  assert.strictEqual(apiToken.expiresAt, null);
  assert.strictEqual(apiToken.lastUsedAt, null);

  const second = await create(alice, { name: "later" });
  const listed = await alice.get("/api/v1/tokens");
  assert.strictEqual(listed.status, 200);
  assert.deepStrictEqual(
    listed.body.map((item) => item.id),
    [second.body.id, apiToken.id],
  );
  for (const item of listed.body)
    assert.deepStrictEqual(Object.keys(item).sort(), [
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "prefix",
    ]);
  assert.ok(!JSON.stringify(listed.body).includes(token));
  assert.deepStrictEqual((await bob.get("/api/v1/tokens")).body, []);
});

test("expiresInDays sets expiry that many days ahead", async () => {
  const created = await create(alice, { name: "month", expiresInDays: 30 });
  assert.strictEqual(created.status, 201);
  const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(new Date(created.body.expiresAt) - expected) < 5000);
});

test("invalid bodies are 422", async () => {
  for (const body of [
    {},
    { name: "   " },
    { name: "x".repeat(101) },
    { name: "x", expiresInDays: 0 },
    { name: "x", expiresInDays: 366 },
    { name: "x", expiresInDays: 1.5 },
  ]) {
    const res = await create(alice, body);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  }
});

test("unverified user can list but gets 403 on create", async () => {
  const unverified = await signUp("unverified-tokens@example.com", {
    verify: false,
  });
  await unverified.post("/api/v1/auth/login").send({
    email: "unverified-tokens@example.com",
    password: "correct-horse-battery",
  });
  assert.strictEqual((await unverified.get("/api/v1/tokens")).status, 200);
  const blocked = await create(unverified, { name: "x" });
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.body.error.code, "EMAIL_NOT_VERIFIED");
});

test("anonymous requests are 401", async () => {
  const res = await request(app.callback()).get("/api/v1/tokens");
  assert.strictEqual(res.status, 401);
});

test("the 21st token is 422 QUOTA_EXCEEDED", async () => {
  const carol = await signUp("carol-tokens@example.com");
  for (let i = 0; i < ApiToken.MAX_PER_WORKSPACE; i++)
    assert.strictEqual((await create(carol, { name: `t${i}` })).status, 201);
  const over = await create(carol, { name: "over" });
  assert.strictEqual(over.status, 422);
  assert.strictEqual(over.body.error.code, "QUOTA_EXCEEDED");
  assert.strictEqual(over.body.error.message, "API token limit reached");
  const workspace = await ownerWorkspace("carol-tokens@example.com");
  assert.strictEqual(
    await ApiToken.count({ where: { workspaceId: workspace.id } }),
    ApiToken.MAX_PER_WORKSPACE,
  );
});

test("delete revokes, another workspace gets 404, audit rows written", async () => {
  const created = await create(alice, { name: "doomed" });
  const { id, prefix } = created.body;

  const foreign = await bob.delete(`/api/v1/tokens/${id}`);
  assert.strictEqual(foreign.status, 404);
  assert.strictEqual(foreign.body.error.code, "NOT_FOUND");
  assert.ok(await ApiToken.findOne({ where: { publicId: id } }));

  const deleted = await alice.delete(`/api/v1/tokens/${id}`);
  assert.strictEqual(deleted.status, 204);
  assert.strictEqual(await ApiToken.findOne({ where: { publicId: id } }), null);
  assert.strictEqual((await alice.delete(`/api/v1/tokens/${id}`)).status, 404);

  const workspace = await ownerWorkspace("alice-tokens@example.com");
  const rows = await AuditLog.findAll({
    where: { workspaceId: workspace.id },
    order: [["id", "ASC"]],
  });
  const forToken = rows.filter((row) => row.meta?.tokenId === id);
  assert.deepStrictEqual(
    forToken.map((row) => row.action),
    ["token.created", "token.revoked"],
  );
  for (const row of forToken) {
    assert.deepStrictEqual(row.meta, { tokenId: id, name: "doomed", prefix });
    assert.strictEqual(String(row.actorUserId), String(workspace.ownerUserId));
    assert.ok(row.ip);
  }
});
