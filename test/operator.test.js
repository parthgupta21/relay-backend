const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase } = require("./helpers");
const { AuditLog, User } = require("../models");
const { setOperator } = require("../scripts/operator");

const seedUser = async (email, { verified = true, deleted = false } = {}) => {
  const { user } = await User.register(email, "correct-horse-battery");
  await user.update({
    emailVerifiedAt: verified ? new Date() : null,
    deletedAt: deleted ? new Date() : null,
  });
  return user;
};

before(resetDatabase);
after(() => sequelize.close());

test("grant and revoke flip the flag and write audit rows", async () => {
  const user = await seedUser("op@example.com");
  await setOperator("  OP@example.com ", true);
  await user.reload();
  assert.strictEqual(user.isOperator, true);
  await setOperator("op@example.com", false);
  await user.reload();
  assert.strictEqual(user.isOperator, false);

  const rows = await AuditLog.findAll({ order: [["id", "ASC"]] });
  assert.deepStrictEqual(
    rows.map((row) => row.action),
    ["operator.granted", "operator.revoked"],
  );
  for (const row of rows) {
    assert.strictEqual(row.actorUserId, null);
    assert.deepStrictEqual(row.meta, { via: "cli", userId: user.publicId });
  }
});

test("grant refuses unverified, deleted and unknown users and changes nothing", async () => {
  const unverified = await seedUser("unverified-op@example.com", {
    verified: false,
  });
  const deleted = await seedUser("deleted-op@example.com", { deleted: true });
  const auditRows = await AuditLog.count();

  await assert.rejects(
    setOperator(unverified.email, true),
    /Email not verified/,
  );
  await assert.rejects(setOperator(deleted.email, true), /User not found/);
  await assert.rejects(setOperator("nobody@example.com", true), /not found/);

  await unverified.reload();
  await deleted.reload();
  assert.strictEqual(unverified.isOperator, false);
  assert.strictEqual(deleted.isOperator, false);
  assert.strictEqual(await AuditLog.count(), auditRows);
});
