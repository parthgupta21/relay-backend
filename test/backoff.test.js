const { test } = require("node:test");
const assert = require("node:assert");
const { retryDelay, parseRetryAfter } = require("../utils/backoff");

test("delay doubles per attempt with half fixed and half random", () => {
  delete process.env.RETRY_BASE_MS;
  delete process.env.RETRY_CAP_MS;
  for (const [attempt, ceiling] of [
    [2, 30000],
    [3, 60000],
    [5, 240000],
  ])
    for (let i = 0; i < 50; i++) {
      const delay = retryDelay(attempt);
      assert.ok(
        delay >= ceiling / 2 && delay <= ceiling,
        `${attempt} ${delay}`,
      );
    }
});

test("delay never exceeds the cap", () => {
  process.env.RETRY_CAP_MS = "1000";
  assert.ok(retryDelay(20) <= 1000);
  assert.strictEqual(retryDelay(2, 5000), 1000);
  delete process.env.RETRY_CAP_MS;
});

test("Retry-After longer than the computed delay wins, shorter does not", () => {
  assert.strictEqual(retryDelay(2, 120000), 120000);
  assert.ok(retryDelay(2, 1000) <= 30000);
});

test("Retry-After parses seconds and HTTP dates", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.strictEqual(parseRetryAfter("120", now), 120000);
  assert.strictEqual(
    parseRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", now),
    60000,
  );
  assert.strictEqual(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now), 0);
  assert.strictEqual(parseRetryAfter("garbage", now), 0);
  assert.strictEqual(parseRetryAfter(undefined, now), 0);
});
