const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const { sha256 } = require("../utils");
const { ApiToken, User, Workspace } = require("../models");

let alice;
let bob;

before(async () => {
  await resetDatabase();
  await signUp("alice@example.com");
  await signUp("bob@example.com");
  alice = await Workspace.findOne({
    include: [{ association: "owner", where: { email: "alice@example.com" } }],
  });
  bob = await Workspace.findOne({
    include: [{ association: "owner", where: { email: "bob@example.com" } }],
  });
});
after(() => sequelize.close());

test("issue returns a prefixed token and stores only its hash", async () => {
  const { apiToken, token } = await ApiToken.issue(alice.id, { name: "ci" });
  assert.match(token, /^rly_[\w-]{43}$/);
  assert.strictEqual(apiToken.prefix, token.slice(0, 12));
  assert.ok(apiToken.tokenHash.equals(sha256(token)));
  assert.strictEqual(apiToken.expiresAt, null);
});

test("issue sets expiry from expiresInDays", async () => {
  const { apiToken } = await ApiToken.issue(alice.id, {
    name: "ci",
    expiresInDays: 30,
  });
  const days = (apiToken.expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29.99 && days <= 30);
});

test("findActive returns the token with workspace and owner", async () => {
  const { token } = await ApiToken.issue(alice.id, { name: "hit" });
  const found = await ApiToken.findActive(token);
  assert.strictEqual(found.workspace.id, alice.id);
  assert.strictEqual(found.workspace.owner.email, "alice@example.com");
});

test("findActive misses unknown and expired tokens", async () => {
  assert.strictEqual(await ApiToken.findActive("rly_unknown"), null);
  const { apiToken, token } = await ApiToken.issue(alice.id, { name: "old" });
  await apiToken.update({ expiresAt: new Date(Date.now() - 1000) });
  assert.strictEqual(await ApiToken.findActive(token), null);
});

test("findActive misses when the owner is deleted", async () => {
  const { token } = await ApiToken.issue(bob.id, { name: "bob" });
  assert.ok(await ApiToken.findActive(token));
  await User.update(
    { deletedAt: new Date() },
    { where: { id: bob.ownerUserId } },
  );
  assert.strictEqual(await ApiToken.findActive(token), null);
});

test("getOwned returns own token and 404s for another workspace", async () => {
  const { apiToken } = await ApiToken.issue(alice.id, { name: "mine" });
  assert.strictEqual(
    (await ApiToken.getOwned(alice.id, apiToken.publicId)).id,
    apiToken.id,
  );
  await assert.rejects(ApiToken.getOwned(bob.id, apiToken.publicId), {
    code: "NOT_FOUND",
    status: 404,
    message: "API token not found",
  });
});

test("present exposes exactly the public fields", async () => {
  const { apiToken, token } = await ApiToken.issue(alice.id, { name: "p" });
  const presented = apiToken.present();
  assert.deepStrictEqual(Object.keys(presented).sort(), [
    "createdAt",
    "expiresAt",
    "id",
    "lastUsedAt",
    "name",
    "prefix",
  ]);
  assert.strictEqual(presented.id, apiToken.publicId);
  assert.ok(!JSON.stringify(presented).includes(token));
});
