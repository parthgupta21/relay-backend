process.env.NODE_ENV = "test";
require("dotenv").config({ quiet: true });
const { test, before, after, mock } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const {
  ApiToken,
  Delivery,
  DeliveryAttempt,
  Destination,
  Endpoint,
  Event,
  Workspace,
} = require("../models");
const { ipToBytes } = require("../utils");

const API = "/api/v1/analytics/deliveries";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const now = Date.now();
mock.method(Date, "now", () => now);
const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

let alice;
let carol;
let bob;
let aliceToken;
let aliceEndpoint;
let aliceSecondEndpoint;
let bobEndpoint;
let primary;
let secondary;
let other;

const hoursAgo = (hours) => new Date(hourStart - hours * HOUR_MS + HOUR_MS / 2);
const daysAgo = (days) => new Date(dayStart - days * DAY_MS + DAY_MS / 2);
const workspaceOf = (email) =>
  Workspace.findOne({ include: [{ association: "owner", where: { email } }] });
const makeEndpoint = (workspace) =>
  Endpoint.create({
    workspaceId: workspace.id,
    name: "e",
    slug: Endpoint.generateSlug(),
  });
const makeDestination = (endpoint, name) =>
  Destination.create({
    endpointId: endpoint.id,
    name,
    url: "https://example.com/hook",
    signingSecret: Destination.encryptSecret(Destination.generateSecret()),
  });
const makeEvent = (endpoint) =>
  Event.create({
    endpointId: endpoint.id,
    method: "POST",
    path: "/",
    headers: {},
    bodySize: 0,
    sourceIp: ipToBytes("127.0.0.1"),
    receivedAt: new Date(),
  });
const deliver = async (
  event,
  destination,
  {
    createdAt = hoursAgo(0),
    status = "succeeded",
    failureReason,
    attempts = [],
  },
) => {
  const delivery = await Delivery.create({
    eventId: event.id,
    destinationId: destination.id,
    trigger: "manual",
    status,
    failureReason,
    createdAt,
  });
  for (const [i, [outcome, durationMs]] of attempts.entries())
    await DeliveryAttempt.create({
      deliveryId: delivery.id,
      attemptNo: i + 1,
      startedAt: createdAt,
      durationMs,
      outcome,
    });
};
const hourlySeries = (points) =>
  Array.from({ length: 24 }, (_, i) => ({
    start: new Date(hourStart - (23 - i) * HOUR_MS).toISOString(),
    succeeded: 0,
    failed: 0,
    inProgress: 0,
    ...points[i],
  }));
const emptyTotals = {
  deliveries: 0,
  succeeded: 0,
  failed: 0,
  inProgress: 0,
  successRate: null,
  attempts: 0,
  p50Ms: null,
  p95Ms: null,
};

before(async () => {
  await resetDatabase();
  alice = await signUp("alice-analytics@example.com");
  bob = await signUp("bob-analytics@example.com");
  carol = await signUp("carol-analytics@example.com");
  const aliceWorkspace = await workspaceOf("alice-analytics@example.com");
  const bobWorkspace = await workspaceOf("bob-analytics@example.com");
  const carolWorkspace = await workspaceOf("carol-analytics@example.com");
  aliceToken = (await ApiToken.issue(aliceWorkspace.id, { name: "a" })).token;
  aliceEndpoint = await makeEndpoint(aliceWorkspace);
  bobEndpoint = await makeEndpoint(bobWorkspace);
  primary = await makeDestination(aliceEndpoint, "primary");
  aliceSecondEndpoint = await makeEndpoint(aliceWorkspace);
  secondary = await makeDestination(aliceSecondEndpoint, "secondary");
  const event = await makeEvent(aliceEndpoint);

  for (const durationMs of [100, 200, 300, 400, 500, 600, 700])
    await deliver(event, primary, { attempts: [["success", durationMs]] });
  await deliver(event, primary, { status: "pending" });
  await deliver(event, primary, {
    createdAt: hoursAgo(1),
    status: "failed",
    failureReason: "non_retryable",
    attempts: [["http_error", 800]],
  });
  await deliver(event, primary, {
    createdAt: hoursAgo(1),
    status: "in_flight",
  });
  await deliver(event, primary, {
    createdAt: hoursAgo(1),
    status: "retry_scheduled",
  });
  await deliver(event, primary, {
    createdAt: hoursAgo(2),
    status: "failed",
    failureReason: "exhausted",
    attempts: [
      ["timeout", 900],
      ["network_error", 1000],
    ],
  });
  await deliver(event, primary, {
    createdAt: hoursAgo(3),
    status: "failed",
    failureReason: "ssrf_blocked",
    attempts: [["blocked", 99999]],
  });
  await deliver(event, primary, {
    createdAt: hoursAgo(3),
    status: "failed",
    failureReason: "destination_disabled",
  });
  for (const createdAt of [hoursAgo(24), hoursAgo(-1)])
    await deliver(event, primary, { createdAt, attempts: [["success", 5]] });
  const secondEvent = await makeEvent(aliceSecondEndpoint);
  await deliver(secondEvent, secondary, {});
  await deliver(secondEvent, secondary, {});
  await secondary.destroy();

  other = await makeDestination(bobEndpoint, "other");
  await deliver(await makeEvent(bobEndpoint), other, {});

  const carolEndpoint = await makeEndpoint(carolWorkspace);
  const carolDestination = await makeDestination(carolEndpoint, "c");
  const carolEvent = await makeEvent(carolEndpoint);
  for (const days of [0, 3, 6, 7])
    await deliver(carolEvent, carolDestination, { createdAt: daysAgo(days) });
});

after(() => sequelize.close());

test("without credentials is 401", async () => {
  const res = await request(app.callback()).get(API);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error.code, "UNAUTHENTICATED");
});

test("a bad range or a long endpointId is 422", async () => {
  for (const query of ["?range=30d", `?endpointId=${"e".repeat(31)}`]) {
    const res = await alice.get(`${API}${query}`);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  }
});

test("returns the exact keys with the default 24h range", async () => {
  const res = await alice.get(API);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.body), [
    "range",
    "bucket",
    "from",
    "to",
    "retentionDays",
    "totals",
    "series",
    "failureReasons",
    "outcomes",
    "destinations",
  ]);
  assert.deepStrictEqual(
    Object.keys(res.body.totals),
    Object.keys(emptyTotals),
  );
  assert.strictEqual(res.body.range, "24h");
  assert.strictEqual(res.body.bucket, "hour");
  assert.strictEqual(res.body.retentionDays, 3);
  assert.strictEqual(
    res.body.from,
    new Date(hourStart - 23 * HOUR_MS).toISOString(),
  );
  assert.strictEqual(res.body.to, new Date(hourStart + HOUR_MS).toISOString());
});

test("24h gives zero-filled hourly buckets, oldest first, with the right split", async () => {
  const res = await alice.get(`${API}?range=24h`);
  assert.deepStrictEqual(
    res.body.series,
    hourlySeries({
      23: { succeeded: 9, inProgress: 1 },
      22: { failed: 1, inProgress: 2 },
      21: { failed: 1 },
      20: { failed: 2 },
    }),
  );
});

test("totals, successRate, failure reasons and outcomes add up", async () => {
  const res = await alice.get(API);
  assert.deepStrictEqual(res.body.totals, {
    deliveries: 16,
    succeeded: 9,
    failed: 4,
    inProgress: 3,
    successRate: 9 / 13,
    attempts: 11,
    p50Ms: 500,
    p95Ms: 1000,
  });
  assert.deepStrictEqual(res.body.failureReasons, {
    non_retryable: 1,
    exhausted: 1,
    ssrf_blocked: 1,
    destination_disabled: 1,
  });
  assert.deepStrictEqual(res.body.outcomes, {
    success: 7,
    http_error: 1,
    timeout: 1,
    network_error: 1,
    blocked: 1,
  });
});

test("destinations are ranked by deliveries and include soft-deleted ones", async () => {
  const res = await alice.get(API);
  assert.deepStrictEqual(res.body.destinations, [
    {
      id: primary.publicId,
      name: "primary",
      deleted: false,
      deliveries: 14,
      succeeded: 7,
      failed: 4,
    },
    {
      id: secondary.publicId,
      name: "secondary",
      deleted: true,
      deliveries: 2,
      succeeded: 2,
      failed: 0,
    },
  ]);
});

test("endpointId limits the result to that endpoint", async () => {
  for (const [endpoint, deliveries] of [
    [aliceEndpoint, 14],
    [aliceSecondEndpoint, 2],
  ]) {
    const res = await alice.get(`${API}?endpointId=${endpoint.publicId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.totals.deliveries, deliveries);
  }
});

test("another workspace's endpointId is 404", async () => {
  const res = await alice.get(`${API}?endpointId=${bobEndpoint.publicId}`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error.code, "NOT_FOUND");
});

test("a workspace only sees its own deliveries", async () => {
  const res = await bob.get(API);
  assert.strictEqual(res.body.totals.deliveries, 1);
  assert.deepStrictEqual(
    res.body.destinations.map(({ id }) => id),
    [other.publicId],
  );
  assert.strictEqual(
    (await bob.get(`${API}?endpointId=${aliceEndpoint.publicId}`)).status,
    404,
  );
});

test("7d gives seven zero-filled daily buckets and excludes older rows", async () => {
  const res = await carol.get(`${API}?range=7d`);
  assert.strictEqual(res.body.bucket, "day");
  assert.deepStrictEqual(
    res.body.series,
    Array.from({ length: 7 }, (_, i) => ({
      start: new Date(dayStart - (6 - i) * DAY_MS).toISOString(),
      succeeded: [0, 3, 6].includes(i) ? 1 : 0,
      failed: 0,
      inProgress: 0,
    })),
  );
  assert.deepStrictEqual(res.body.totals, {
    ...emptyTotals,
    deliveries: 3,
    succeeded: 3,
    successRate: 1,
  });
});

test("a workspace with no deliveries gets zeros and nulls", async () => {
  const empty = await signUp("dave-analytics@example.com");
  const res = await empty.get(API);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.totals, emptyTotals);
  assert.deepStrictEqual(res.body.series, hourlySeries({}));
  assert.deepStrictEqual(res.body.destinations, []);
});

test("an API token returns the same totals as a session", async () => {
  const res = await request(app.callback())
    .get(API)
    .set({ Authorization: `Bearer ${aliceToken}` });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.totals, (await alice.get(API)).body.totals);
});
