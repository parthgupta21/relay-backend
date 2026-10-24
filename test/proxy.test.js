const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase } = require("./helpers");
const { AuditLog } = require("../models");
const { bytesToIp } = require("../utils");

before(resetDatabase);
after(() => sequelize.close());

test("with TRUST_PROXY only the last X-Forwarded-For hop is used", async () => {
  app.proxy = true;
  const res = await request(app.callback())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", "garbage, 1.2.3.4")
    .send({ email: "nobody@example.com", password: "wrong-password" });
  app.proxy = false;
  assert.strictEqual(res.status, 401);
  const row = await AuditLog.findOne({ where: { action: "login.failed" } });
  assert.strictEqual(bytesToIp(row.ip), "1.2.3.4");
});

test("a valid X-Request-Id is echoed back", async () => {
  const res = await request(app.callback())
    .get("/healthz")
    .set("X-Request-Id", "abc-123_DEF");
  assert.strictEqual(res.headers["x-request-id"], "abc-123_DEF");
});

test("an invalid X-Request-Id is replaced with a uuid", async () => {
  for (const id of ["has space", "x".repeat(65), "a;b"]) {
    const res = await request(app.callback())
      .get("/healthz")
      .set("X-Request-Id", id);
    assert.match(res.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  }
});
