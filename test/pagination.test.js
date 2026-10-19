const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const { Endpoint, Event } = require("../models");

let agent;
let endpoint;
const TOTAL = 23;

before(async () => {
  await resetDatabase();
  agent = await signUp("pages@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "pages" }))
    .body;
  const row = await Endpoint.findOne({ where: { slug: endpoint.slug } });
  const sameMillisecond = new Date("2026-01-01T00:00:00.000Z");
  await Event.bulkCreate(
    Array.from({ length: TOTAL }, (_, i) => ({
      endpointId: row.id,
      method: i % 2 ? "POST" : "GET",
      path: `/${i}`,
      headers: {},
      bodySize: 0,
      sourceIp: Buffer.from([127, 0, 0, 1]),
      receivedAt:
        i < 10
          ? sameMillisecond
          : new Date(sameMillisecond.getTime() + i * 1000),
    })),
  );
});
after(() => sequelize.close());

const url = (query) => `/api/v1/endpoints/${endpoint.id}/events?${query}`;

test("keyset pagination returns every event exactly once, newest first", async () => {
  const seen = [];
  let cursor = "";
  let pages = 0;
  do {
    const res = await agent.get(url(`limit=5${cursor && `&cursor=${cursor}`}`));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.items.length <= 5);
    seen.push(...res.body.items);
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor);

  assert.strictEqual(pages, 5);
  assert.strictEqual(seen.length, TOTAL);
  assert.strictEqual(new Set(seen.map((e) => e.id)).size, TOTAL);
  const times = seen.map((e) => new Date(e.receivedAt).getTime());
  assert.deepStrictEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  assert.deepStrictEqual(Object.keys(seen[0]).sort(), [
    "bodySize",
    "contentType",
    "id",
    "method",
    "path",
    "receivedAt",
    "sourceIp",
  ]);
  assert.strictEqual(seen[0].sourceIp, "127.0.0.1");
});

test("exact page boundary has no extra page", async () => {
  const res = await agent.get(url(`limit=${TOTAL}`));
  assert.strictEqual(res.body.items.length, TOTAL);
  assert.strictEqual(res.body.nextCursor, null);
});

test("method filter, default limit and bad input", async () => {
  const gets = await agent.get(url("method=get"));
  assert.strictEqual(gets.body.items.length, 12);
  assert.ok(gets.body.items.every((e) => e.method === "GET"));

  assert.strictEqual((await agent.get(url(""))).body.items.length, TOTAL);
  for (const query of ["limit=0", "limit=101", "limit=abc", "cursor=garbage"]) {
    const res = await agent.get(url(query));
    assert.strictEqual(res.status, 422, query);
    assert.strictEqual(res.body.error.code, "VALIDATION_FAILED");
  }
});
