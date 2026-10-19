process.env.NODE_ENV = "test";
require("dotenv").config({ quiet: true });
const { once } = require("node:events");
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const queue = require("../services/queue");
const { acquire, release } = require("../services/semaphore");

const scope = { destinationId: 9001, workspaceId: 9002 };
const keys = ["test:sem:dst:9001", "test:sem:ws:9002"];

before(async () => {
  if (queue.connection.status !== "ready")
    await once(queue.connection, "ready");
});
beforeEach(async () => {
  await queue.connection.del(...keys, "test:sem:dst:9003");
  process.env.DESTINATION_CONCURRENCY = "2";
  process.env.WORKSPACE_CONCURRENCY = "3";
});
after(async () => {
  await queue.connection.del(...keys, "test:sem:dst:9003");
  delete process.env.DESTINATION_CONCURRENCY;
  delete process.env.WORKSPACE_CONCURRENCY;
  await queue.close();
});

test("destination cap blocks the next acquire until a release", async () => {
  assert.ok(await acquire(scope, "j1"));
  assert.ok(await acquire(scope, "j2"));
  assert.strictEqual(await acquire(scope, "j3"), false);
  await release(scope, "j1");
  assert.ok(await acquire(scope, "j3"));
  assert.strictEqual(await queue.connection.zcard(keys[0]), 2);
  assert.strictEqual(await queue.connection.zcard(keys[1]), 2);
});

test("a refused acquire leaves no entry behind", async () => {
  await acquire(scope, "j1");
  await acquire(scope, "j2");
  await acquire(scope, "j3");
  assert.strictEqual(await queue.connection.zscore(keys[0], "j3"), null);
  assert.strictEqual(await queue.connection.zscore(keys[1], "j3"), null);
});

test("workspace cap applies across destinations", async () => {
  const other = { destinationId: 9003, workspaceId: 9002 };
  assert.ok(await acquire(scope, "j1"));
  assert.ok(await acquire(scope, "j2"));
  assert.ok(await acquire(other, "j3"));
  assert.strictEqual(await acquire(other, "j4"), false);
});

test("expired slots are reclaimed on the next acquire", async () => {
  await queue.connection.zadd(keys[0], Date.now() - 1, "dead1");
  await queue.connection.zadd(keys[0], Date.now() - 1, "dead2");
  await queue.connection.zadd(keys[1], Date.now() - 1, "dead1");
  await queue.connection.zadd(keys[1], Date.now() - 1, "dead2");
  assert.ok(await acquire(scope, "j1"));
  assert.deepStrictEqual(await queue.connection.zrange(keys[0], 0, -1), ["j1"]);
  assert.deepStrictEqual(await queue.connection.zrange(keys[1], 0, -1), ["j1"]);
});

test("release is safe for an unknown job", async () => {
  await release(scope, "never");
});
