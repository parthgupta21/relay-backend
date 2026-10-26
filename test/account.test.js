const { test, before, after } = require("node:test");
const assert = require("node:assert");
const {
  app,
  request,
  sequelize,
  resetDatabase,
  signUp,
  waitForEmail,
  PASSWORD,
} = require("./helpers");
const {
  ApiToken,
  AuditLog,
  Delivery,
  Destination,
  EmailToken,
  Endpoint,
  Event,
  Session,
  User,
  Workspace,
} = require("../models");
const queue = require("../services/queue");
const { purgeExpired } = require("../services/retention");

const API = "/api/v1";
const ALICE = "alice-account@example.com";

let alice;
let bob;
let aliceWorkspace;
let bobWorkspace;
let aliceToken;
let aliceEndpoint;
let bobEndpoint;

const workspaceOf = (email) =>
  Workspace.findOne({
    include: [{ association: "owner", where: { email } }],
  });
const remove = (agent, password = PASSWORD) =>
  agent.post(`${API}/account/delete`).send({ password });
const seed = async (agent, workspace, name) => {
  const endpoint = (await agent.post(`${API}/endpoints`).send({ name })).body;
  await agent
    .post(`${API}/endpoints/${endpoint.id}/destinations`)
    .send({ name, url: "http://93.184.216.34/hook" });
  await request(app.callback()).post(`/h/${endpoint.slug}`).send("payload");
  await queue.connection.set(`test:usage:${workspace.id}:events:20260101`, "1");
  await queue.connection.set(`test:idem:${workspace.id}:key`, "{}");
  return endpoint;
};
const redisKeys = (workspace) =>
  Promise.all([
    queue.connection.keys(`test:usage:${workspace.id}:*`),
    queue.connection.keys(`test:idem:${workspace.id}:*`),
  ]).then((keys) => keys.flat());

before(async () => {
  await resetDatabase();
  alice = await signUp(ALICE);
  bob = await signUp("bob-account@example.com");
  aliceWorkspace = await workspaceOf(ALICE);
  bobWorkspace = await workspaceOf("bob-account@example.com");
  aliceToken = (await ApiToken.issue(aliceWorkspace.id, { name: "a" })).token;
  await ApiToken.issue(bobWorkspace.id, { name: "b" });
  aliceEndpoint = await seed(alice, aliceWorkspace, "alice");
  bobEndpoint = await seed(bob, bobWorkspace, "bob");
});
after(() => sequelize.close());

test("wrong or invalid password is 422 and changes nothing", async () => {
  const wrong = await remove(alice, "not-the-password");
  assert.strictEqual(wrong.status, 422);
  assert.strictEqual(wrong.body.error.code, "VALIDATION_FAILED");
  assert.strictEqual(wrong.body.error.details[0].path, "body.password");
  for (const body of [{}, { password: "" }, { password: "x".repeat(257) }])
    assert.strictEqual(
      (await alice.post(`${API}/account/delete`).send(body)).status,
      422,
    );
  assert.strictEqual(
    (await User.findByPk(aliceWorkspace.ownerUserId)).deletedAt,
    null,
  );
  assert.strictEqual((await workspaceOf(ALICE)).status, "active");
  assert.strictEqual((await alice.get(`${API}/auth/me`)).status, 200);

  const failed = await AuditLog.findAll({
    where: { action: "account.delete_failed", workspaceId: aliceWorkspace.id },
  });
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(
    String(failed[0].actorUserId),
    String(aliceWorkspace.ownerUserId),
  );
  assert.ok(failed[0].ip);
  assert.strictEqual(failed[0].meta, null);
});

test("anonymous, bearer-only, foreign-origin and operator requests are rejected", async () => {
  const anonymous = await request(app.callback())
    .post(`${API}/account/delete`)
    .send({ password: PASSWORD });
  assert.strictEqual(anonymous.status, 401);

  const bearer = await request(app.callback())
    .post(`${API}/account/delete`)
    .set("Authorization", `Bearer ${aliceToken}`)
    .send({ password: PASSWORD });
  assert.strictEqual(bearer.status, 401);

  const evil = await alice
    .post(`${API}/account/delete`)
    .set("Origin", "https://evil.example")
    .send({ password: PASSWORD });
  assert.strictEqual(evil.status, 403);

  const operator = await signUp("operator-account@example.com");
  await User.update(
    { isOperator: true },
    { where: { email: "operator-account@example.com" } },
  );
  const refused = await remove(operator);
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(
    refused.body.error.message,
    "Operators cannot delete their account",
  );
  assert.strictEqual((await workspaceOf(ALICE)).status, "active");
  assert.strictEqual(
    (await workspaceOf("operator-account@example.com")).status,
    "active",
  );
});

test("delete tombstones the account and locks it out", async () => {
  const userId = aliceWorkspace.ownerUserId;
  const publicId = (await User.findByPk(userId)).publicId;
  assert.strictEqual(await Session.count({ where: { userId } }), 1);
  assert.ok((await redisKeys(aliceWorkspace)).length);
  const bobKeys = await redisKeys(bobWorkspace);

  const res = await remove(alice);
  assert.strictEqual(res.status, 204);
  assert.match(res.headers["set-cookie"].join(";"), /relay_sid=;/);

  assert.strictEqual((await alice.get(`${API}/auth/me`)).status, 401);
  const user = await User.findByPk(userId);
  assert.ok(user.deletedAt);
  assert.strictEqual(user.email, `deleted-${publicId}@deleted.invalid`);
  assert.strictEqual(user.passwordHash, "!");
  assert.strictEqual((await workspaceOf(user.email)).status, "deleted");
  assert.strictEqual(await Session.count({ where: { userId } }), 0);
  assert.strictEqual(await EmailToken.count({ where: { userId } }), 0);
  assert.strictEqual(
    await ApiToken.count({ where: { workspaceId: aliceWorkspace.id } }),
    0,
  );

  const old = await request(app.callback())
    .get(`${API}/endpoints`)
    .set("Authorization", `Bearer ${aliceToken}`);
  assert.strictEqual(old.status, 401);
  const login = await request(app.callback())
    .post(`${API}/auth/login`)
    .send({ email: ALICE, password: PASSWORD });
  assert.strictEqual(login.status, 401);
  const ingest = await request(app.callback())
    .post(`/h/${aliceEndpoint.slug}`)
    .send("payload");
  assert.strictEqual(ingest.status, 404);

  assert.deepStrictEqual(await redisKeys(aliceWorkspace), []);
  assert.deepStrictEqual(await redisKeys(bobWorkspace), bobKeys);
  assert.strictEqual(
    await ApiToken.count({ where: { workspaceId: bobWorkspace.id } }),
    1,
  );

  const audit = await AuditLog.findOne({
    where: { action: "account.deleted", workspaceId: aliceWorkspace.id },
  });
  assert.deepStrictEqual(audit.meta, { userId: publicId });
  assert.strictEqual(String(audit.actorUserId), String(userId));
  assert.ok(audit.ip);
});

test("the same email can register again after deletion", async () => {
  const res = await request(app.callback())
    .post(`${API}/auth/register`)
    .send({ email: ALICE, password: PASSWORD });
  assert.strictEqual(res.status, 202);
  assert.match(await waitForEmail(ALICE, "Verify"), /token=/);
  assert.strictEqual(await User.count({ where: { email: ALICE } }), 1);
});

test("purge removes the deleted workspace's tenant data and keeps others", async (t) => {
  t.after(async () => queue.connection.del(...(await redisKeys(bobWorkspace))));
  const aliceEndpoints = { where: { workspaceId: aliceWorkspace.id } };
  assert.strictEqual(await Endpoint.count(aliceEndpoints), 1);

  assert.strictEqual(await purgeExpired(), 1);

  assert.strictEqual(await Endpoint.count(aliceEndpoints), 0);
  assert.strictEqual(await Destination.count(), 1);
  assert.strictEqual(await Event.count(), 1);
  assert.strictEqual(await Delivery.count(), 1);
  assert.strictEqual(
    (await Event.findOne()).endpointId,
    (await Endpoint.findOne({ where: { publicId: bobEndpoint.id } })).id,
  );
});

test("a suspended workspace gets 403 before the password is checked", async () => {
  const carol = await signUp("carol-account@example.com");
  const workspace = await workspaceOf("carol-account@example.com");
  await workspace.update({ status: "suspended" });

  const res = await remove(carol, "not-the-password");

  assert.strictEqual(res.status, 403);
  assert.strictEqual(
    await AuditLog.count({
      where: { action: "account.delete_failed", workspaceId: workspace.id },
    }),
    0,
  );
});

test("a redis failure during cleanup still deletes the account", async (t) => {
  const dave = await signUp("dave-account@example.com");
  const workspace = await workspaceOf("dave-account@example.com");
  t.mock.method(queue.connection, "scanStream", () => {
    throw new Error("redis down");
  });
  t.mock.method(console, "warn", () => {});

  const res = await remove(dave);

  assert.strictEqual(res.status, 204);
  assert.strictEqual(
    (await Workspace.findByPk(workspace.id)).status,
    "deleted",
  );
  assert.strictEqual(
    await AuditLog.count({
      where: { action: "account.deleted", workspaceId: workspace.id },
    }),
    1,
  );
});
