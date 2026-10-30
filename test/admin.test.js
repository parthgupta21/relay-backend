const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const {
  ApiToken,
  AuditLog,
  Delivery,
  Endpoint,
  Session,
  User,
  Workspace,
} = require("../models");
const { processDelivery } = require("../services/delivery");
const queue = require("../services/queue");

const API = "/api/v1";
const OPERATOR = "root-admin@example.com";
const ALICE = "alice-admin@example.com";
const PAGED = 7;

let operator;
let alice;
let operatorToken;
let aliceWorkspace;

const workspaceOf = (email) =>
  Workspace.findOne({
    include: [{ association: "owner", where: { email } }],
  });
const seedUser = async (email) => {
  const { user } = await User.register(email, "correct-horse-battery");
  await user.update({ emailVerifiedAt: new Date() });
};
const admin = (agent, path) => agent.get(`${API}/admin${path}`);
const ids = (res) => res.body.items.map((item) => item.id);
const ownerEmails = (res) => res.body.items.map((item) => item.ownerEmail);

before(async () => {
  await resetDatabase();
  operator = await signUp(OPERATOR);
  alice = await signUp(ALICE);
  await User.update({ isOperator: true }, { where: { email: OPERATOR } });
  aliceWorkspace = await workspaceOf(ALICE);
  operatorToken = (
    await ApiToken.issue((await workspaceOf(OPERATOR)).id, { name: "op" })
  ).token;
  const endpoint = (
    await alice.post(`${API}/endpoints`).send({ name: "secret-hook" })
  ).body;
  await alice
    .post(`${API}/endpoints/${endpoint.id}/destinations`)
    .send({ name: "dest", url: "http://93.184.216.34/hook" });
  await request(app.callback()).post(`/h/${endpoint.slug}`).send("payload");
  for (const email of [
    "50%off@example.com",
    "500off@example.com",
    "a_b@example.com",
    "axb@example.com",
  ])
    await seedUser(email);
  for (let i = 0; i < PAGED; i++) await seedUser(`paged${i}@pages.example.com`);
  await AuditLog.record("login.failed", { ip: "203.0.113.9" });
});
after(() => sequelize.close());

test("a non-operator session is 403 on every admin route", async () => {
  for (const path of [
    "/workspaces",
    `/workspaces/${aliceWorkspace.publicId}`,
    "/audit",
  ]) {
    const res = await admin(alice, path);
    assert.strictEqual(res.status, 403, path);
    assert.strictEqual(res.body.error.message, "Operator access required");
  }
  assert.strictEqual((await alice.get(`${API}/endpoints`)).status, 200);
});

test("bearer is never accepted on admin routes", async () => {
  for (const path of ["/workspaces", "/audit"]) {
    const bare = await request(app.callback())
      .get(`${API}/admin${path}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    assert.strictEqual(bare.status, 401, path);
    const withCookie = await alice
      .get(`${API}/admin${path}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    assert.strictEqual(withCookie.status, 403, path);
  }
});

test("/auth/me exposes isOperator", async () => {
  assert.strictEqual(
    (await operator.get(`${API}/auth/me`)).body.user.isOperator,
    true,
  );
  assert.strictEqual(
    (await alice.get(`${API}/auth/me`)).body.user.isOperator,
    false,
  );
});

test("list searches by owner email prefix and treats % and _ literally", async () => {
  const search = async (q) =>
    ownerEmails(
      await admin(operator, `/workspaces?q=${encodeURIComponent(q)}`),
    );
  assert.deepStrictEqual(await search("  ALICE-"), [ALICE]);
  assert.deepStrictEqual(await search("50%"), ["50%off@example.com"]);
  assert.deepStrictEqual(await search("a_b"), ["a_b@example.com"]);
  assert.deepStrictEqual(await search("%"), []);
  assert.deepStrictEqual(await search("example.com"), []);

  const first = (await admin(operator, `/workspaces?q=${ALICE}`)).body.items[0];
  assert.deepStrictEqual(Object.keys(first), [
    "id",
    "status",
    "ownerEmail",
    "ownerVerified",
    "ownerIsOperator",
    "endpointCount",
    "createdAt",
  ]);
  assert.strictEqual(first.id, aliceWorkspace.publicId);
  assert.strictEqual(first.endpointCount, 1);
  assert.strictEqual(first.ownerVerified, true);
  assert.strictEqual(first.ownerIsOperator, false);
});

test("list filters by status and rejects bad queries", async () => {
  await aliceWorkspace.update({ status: "suspended" });
  try {
    const suspended = await admin(operator, "/workspaces?status=suspended");
    assert.deepStrictEqual(ownerEmails(suspended), [ALICE]);
    const active = await admin(operator, "/workspaces?status=active");
    assert.ok(!ownerEmails(active).includes(ALICE));
  } finally {
    await aliceWorkspace.update({ status: "active" });
  }
  for (const query of [
    "status=gone",
    "limit=0",
    "limit=101",
    "q=",
    "cursor=not-a-cursor",
  ])
    assert.strictEqual(
      (await admin(operator, `/workspaces?${query}`)).status,
      422,
      query,
    );
});

test("list cursor pages are disjoint and complete", async () => {
  const seen = [];
  let cursor = "";
  let pages = 0;
  do {
    const res = await admin(
      operator,
      `/workspaces?q=paged&limit=3${cursor && `&cursor=${cursor}`}`,
    );
    assert.strictEqual(res.status, 200);
    seen.push(...ids(res));
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor);
  assert.strictEqual(pages, 3);
  assert.strictEqual(new Set(seen).size, PAGED);
  const all = await admin(operator, "/workspaces?q=paged");
  assert.deepStrictEqual(seen, ids(all));
});

test("detail has exact keys and no destination url, secret or body", async (t) => {
  const res = await admin(operator, `/workspaces/${aliceWorkspace.publicId}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.body), [
    "id",
    "status",
    "createdAt",
    "limits",
    "owner",
    "counts",
    "usage",
    "audit",
  ]);
  assert.deepStrictEqual(res.body.counts, {
    endpoints: 1,
    destinations: 1,
    apiTokens: 0,
  });
  assert.deepStrictEqual(Object.keys(res.body.owner), [
    "id",
    "email",
    "emailVerified",
    "isOperator",
    "deletedAt",
  ]);
  assert.match(res.body.owner.id, /^usr_/);
  assert.strictEqual(res.body.usage.month.eventsLimit, 100000);
  assert.ok(res.body.audit.length <= 20);
  assert.ok(res.body.audit.every((row) => row.workspaceId === res.body.id));
  assert.doesNotMatch(JSON.stringify(res.body), /signingSecret|url|body/);

  queue.connection.status = "reconnecting";
  t.after(() => {
    queue.connection.status = "ready";
  });
  const down = await admin(operator, `/workspaces/${aliceWorkspace.publicId}`);
  assert.strictEqual(down.status, 200);
  assert.strictEqual(down.body.usage, null);
});

test("detail of an unknown workspace is 404", async () => {
  const res = await admin(operator, "/workspaces/ws_missing");
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error.message, "Workspace not found");
});

test("audit filters by workspace and action, login.failed has no workspace", async () => {
  const failed = await admin(operator, "/audit?action=login.failed");
  assert.strictEqual(failed.status, 200);
  assert.strictEqual(failed.body.items.length, 1);
  assert.deepStrictEqual(Object.keys(failed.body.items[0]), [
    "action",
    "workspaceId",
    "actorEmail",
    "ip",
    "meta",
    "createdAt",
  ]);
  assert.strictEqual(failed.body.items[0].workspaceId, null);
  assert.strictEqual(failed.body.items[0].actorEmail, null);
  assert.strictEqual(failed.body.items[0].ip, "203.0.113.9");

  const scoped = await admin(
    operator,
    `/audit?workspaceId=${aliceWorkspace.publicId}`,
  );
  assert.ok(scoped.body.items.length > 0);
  assert.ok(
    scoped.body.items.every(
      (row) => row.workspaceId === aliceWorkspace.publicId,
    ),
  );
  const logins = await admin(
    operator,
    `/audit?workspaceId=${aliceWorkspace.publicId}&action=login`,
  );
  assert.deepStrictEqual(
    logins.body.items.map((row) => [row.action, row.actorEmail]),
    [["login", ALICE]],
  );

  const unknown = await admin(operator, "/audit?workspaceId=ws_missing");
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(
    (await admin(operator, `/audit?action=${"x".repeat(65)}`)).status,
    422,
  );
});

test("audit cursor pages are disjoint and complete", async () => {
  const all = await admin(operator, "/audit?limit=100");
  assert.strictEqual(all.body.nextCursor, null);
  const seen = [];
  let cursor = "";
  do {
    const res = await admin(
      operator,
      `/audit?limit=4${cursor && `&cursor=${cursor}`}`,
    );
    assert.strictEqual(res.status, 200);
    seen.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  assert.deepStrictEqual(seen, all.body.items);
});

const patch = (agent, workspace, body) =>
  agent.patch(`${API}/admin/workspaces/${workspace.publicId}`).send(body);
const destroy = (agent, workspace, confirm) =>
  agent
    .post(`${API}/admin/workspaces/${workspace.publicId}/delete`)
    .send({ confirm });
const auditCount = (workspace, action) =>
  AuditLog.count({ where: { workspaceId: workspace.id, action } });
const operatorId = async () => (await workspaceOf(OPERATOR)).ownerUserId;
const seedTenant = async (email) => {
  const agent = await signUp(email);
  const workspace = await workspaceOf(email);
  const token = (await ApiToken.issue(workspace.id, { name: "t" })).token;
  const endpoint = (await agent.post(`${API}/endpoints`).send({ name: "e" }))
    .body;
  await agent
    .post(`${API}/endpoints/${endpoint.id}/destinations`)
    .send({ name: "d", url: "http://93.184.216.34/hook" });
  await request(app.callback()).post(`/h/${endpoint.slug}`).send("payload");
  return { agent, workspace, token, endpoint };
};

test("admin writes are operator-only and reject bad input with 422", async () => {
  assert.strictEqual(
    (await patch(alice, aliceWorkspace, { status: "suspended" })).status,
    403,
  );
  assert.strictEqual((await destroy(alice, aliceWorkspace, ALICE)).status, 403);
  const missing = { publicId: "ws_missing" };
  assert.strictEqual(
    (await patch(operator, missing, { status: "active" })).status,
    404,
  );
  assert.strictEqual((await destroy(operator, missing, ALICE)).status, 404);
  for (const body of [
    {},
    { unknown: 1 },
    { status: "deleted" },
    { limits: {} },
    { limits: { unknown: 1 } },
    { limits: { maxEndpoints: 0 } },
    { limits: { maxEndpoints: 1001 } },
    { limits: { maxEndpoints: 1.5 } },
    { limits: { maxDestinations: 101 } },
    { limits: { maxEventsPerDay: 10_000_001 } },
    { limits: { maxEventsPerMonth: 100_000_001 } },
    { limits: { maxBodyBytes: 1023 } },
    { limits: { maxBodyBytes: 10_485_761 } },
    { limits: { retentionDays: 91 } },
  ])
    assert.strictEqual(
      (await patch(operator, aliceWorkspace, body)).status,
      422,
      JSON.stringify(body),
    );
  for (const body of [{}, { confirm: "" }, { confirm: 1 }])
    assert.strictEqual(
      (
        await operator
          .post(`${API}/admin/workspaces/${aliceWorkspace.publicId}/delete`)
          .send(body)
      ).status,
      422,
    );
  assert.strictEqual((await workspaceOf(ALICE)).status, "active");
});

test("suspend blocks the tenant, reactivate restores the same session, one audit row each", async () => {
  const bob = await seedTenant("bob-admin@example.com");
  const stored = await Endpoint.findOne({
    where: { publicId: bob.endpoint.id },
  });
  const delivery = await Delivery.findOne({
    include: [
      {
        association: "event",
        required: true,
        where: { endpointId: stored.id },
      },
    ],
  });

  const suspended = await patch(operator, bob.workspace, {
    status: "suspended",
  });
  assert.strictEqual(suspended.status, 200);
  assert.strictEqual(suspended.body.status, "suspended");
  assert.strictEqual(suspended.body.id, bob.workspace.publicId);
  assert.strictEqual(
    (await patch(operator, bob.workspace, { status: "suspended" })).status,
    200,
  );
  assert.strictEqual((await bob.agent.get(`${API}/auth/me`)).status, 403);
  assert.strictEqual(
    (
      await request(app.callback())
        .get(`${API}/endpoints`)
        .set("Authorization", `Bearer ${bob.token}`)
    ).status,
    403,
  );
  assert.strictEqual(
    (await request(app.callback()).post(`/h/${bob.endpoint.slug}`).send("x"))
      .status,
    404,
  );
  await processDelivery(delivery.id);
  await delivery.reload();
  assert.strictEqual(delivery.status, "failed");
  assert.strictEqual(delivery.failureReason, "destination_disabled");

  const audit = await AuditLog.findAll({
    where: {
      workspaceId: bob.workspace.id,
      action: "admin.workspace.suspended",
    },
  });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(String(audit[0].actorUserId), String(await operatorId()));
  assert.ok(audit[0].ip);
  assert.strictEqual(audit[0].meta, null);

  const reactivated = await patch(operator, bob.workspace, {
    status: "active",
  });
  assert.strictEqual(reactivated.status, 200);
  assert.strictEqual(reactivated.body.status, "active");
  assert.strictEqual((await bob.agent.get(`${API}/auth/me`)).status, 200);
  assert.strictEqual(
    await auditCount(bob.workspace, "admin.workspace.reactivated"),
    1,
  );
  assert.strictEqual(
    await auditCount(bob.workspace, "admin.workspace.suspended"),
    1,
  );
});

test("limits update applies, audits changed keys only, and keeps existing endpoints", async () => {
  const dave = await seedTenant("dave-admin@example.com");
  await dave.agent.post(`${API}/endpoints`).send({ name: "second" });

  const res = await patch(operator, dave.workspace, {
    limits: { maxEndpoints: 1, maxEventsPerMonth: 1, maxDestinations: 3 },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.limits.maxEndpoints, 1);
  assert.strictEqual(res.body.limits.maxEventsPerMonth, 1);
  assert.strictEqual(res.body.limits.maxDestinations, 3);
  assert.strictEqual(res.body.counts.endpoints, 2);

  const rows = await AuditLog.findAll({
    where: {
      workspaceId: dave.workspace.id,
      action: "admin.workspace.limits_updated",
    },
  });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].meta, {
    before: { maxEndpoints: 5, maxEventsPerMonth: 100000 },
    after: { maxEndpoints: 1, maxEventsPerMonth: 1 },
  });

  const again = await patch(operator, dave.workspace, {
    limits: { maxEndpoints: 1 },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(
    await auditCount(dave.workspace, "admin.workspace.limits_updated"),
    1,
  );

  assert.strictEqual((await dave.agent.get(`${API}/endpoints`)).body.length, 2);
  const create = await dave.agent.post(`${API}/endpoints`).send({ name: "x" });
  assert.strictEqual(create.status, 422);
  assert.strictEqual(create.body.error.code, "QUOTA_EXCEEDED");

  const ingest = await request(app.callback())
    .post(`/h/${dave.endpoint.slug}`)
    .send("x");
  assert.strictEqual(ingest.status, 429);
  assert.strictEqual(ingest.body.error.code, "QUOTA_EXCEEDED");
});

test("an operator cannot change the status of their own workspace", async () => {
  const own = await workspaceOf(OPERATOR);
  for (const status of ["suspended", "active"]) {
    const res = await patch(operator, own, { status });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(
      res.body.error.message,
      "Cannot change the status of your own workspace",
    );
  }
  assert.strictEqual((await workspaceOf(OPERATOR)).status, "active");
  assert.strictEqual(
    (await patch(operator, own, { limits: { retentionDays: 2 } })).status,
    200,
  );
  assert.strictEqual(await auditCount(own, "admin.workspace.suspended"), 0);
  assert.strictEqual(await auditCount(own, "admin.workspace.reactivated"), 0);
});

test("admin delete needs the exact owner email and refuses operator workspaces", async () => {
  const carol = await seedTenant("carol-admin@example.com");
  const erin = (await seedTenant("erin-admin@example.com")).workspace;
  await User.update({ isOperator: true }, { where: { id: erin.ownerUserId } });

  for (const confirm of [
    "wrong",
    "carol-admin@example.com ",
    "CAROL-ADMIN@example.com",
  ]) {
    const res = await destroy(operator, carol.workspace, confirm);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error.details[0].path, "body.confirm");
  }
  assert.strictEqual(
    (await workspaceOf("carol-admin@example.com")).status,
    "active",
  );
  assert.strictEqual(
    await auditCount(carol.workspace, "admin.workspace.deleted"),
    0,
  );

  for (const [workspace, email] of [
    [await workspaceOf(OPERATOR), OPERATOR],
    [erin, "erin-admin@example.com"],
  ]) {
    const res = await destroy(operator, workspace, email);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(
      res.body.error.message,
      "Cannot delete an operator's workspace",
    );
    assert.strictEqual(
      (await Workspace.findByPk(workspace.id)).status,
      "active",
    );
  }
});

test("admin delete tombstones the account like self-delete, with the admin action", async () => {
  const frank = await seedTenant("frank-admin@example.com");
  const email = "frank-admin@example.com";
  const userId = frank.workspace.ownerUserId;
  const publicId = (await User.findByPk(userId)).publicId;
  await queue.connection.set(
    `test:usage:${frank.workspace.id}:events:20260101`,
    "1",
  );
  await queue.connection.set(`test:idem:${frank.workspace.id}:key`, "{}");

  const res = await destroy(operator, frank.workspace, email);
  assert.strictEqual(res.status, 204);

  const user = await User.findByPk(userId);
  assert.ok(user.deletedAt);
  assert.strictEqual(user.email, `deleted-${publicId}@deleted.invalid`);
  assert.strictEqual(user.passwordHash, "!");
  assert.strictEqual(
    (await Workspace.findByPk(frank.workspace.id)).status,
    "deleted",
  );
  assert.strictEqual(await Session.count({ where: { userId } }), 0);
  assert.strictEqual(
    await ApiToken.count({ where: { workspaceId: frank.workspace.id } }),
    0,
  );
  assert.strictEqual((await frank.agent.get(`${API}/auth/me`)).status, 401);
  assert.strictEqual(
    (await request(app.callback()).post(`/h/${frank.endpoint.slug}`).send("x"))
      .status,
    404,
  );
  for (const kind of ["usage", "idem"])
    assert.deepStrictEqual(
      await queue.connection.keys(`test:${kind}:${frank.workspace.id}:*`),
      [],
    );

  const rows = await AuditLog.findAll({
    where: {
      workspaceId: frank.workspace.id,
      action: "admin.workspace.deleted",
    },
  });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].meta, { userId: publicId });
  assert.strictEqual(String(rows[0].actorUserId), String(await operatorId()));
  assert.ok(rows[0].ip);
  assert.strictEqual(await auditCount(frank.workspace, "account.deleted"), 0);

  const again = await destroy(operator, frank.workspace, email);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error.message, "Workspace is deleted");
  const patched = await patch(operator, frank.workspace, {
    limits: { retentionDays: 2 },
  });
  assert.strictEqual(patched.status, 409);
  assert.strictEqual(patched.body.error.message, "Workspace is deleted");
});

test("concurrent admin deletes write one tombstone and one audit row", async () => {
  const email = "grace-admin@example.com";
  const grace = await seedTenant(email);
  const results = await Promise.all(
    [0, 1].map(() => destroy(operator, grace.workspace, email)),
  );
  assert.deepStrictEqual(results.map((res) => res.status).sort(), [204, 409]);
  assert.strictEqual(
    await auditCount(grace.workspace, "admin.workspace.deleted"),
    1,
  );
});
