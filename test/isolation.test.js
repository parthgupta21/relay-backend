const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");

let alice;
let bob;
let endpoint;
let eventId;

before(async () => {
  await resetDatabase();
  alice = await signUp("alice@example.com");
  bob = await signUp("bob@example.com");
  endpoint = (await alice.post("/api/v1/endpoints").send({ name: "private" }))
    .body;
  eventId = (
    await request(app.callback()).post(`/h/${endpoint.slug}`).send("secret")
  ).body.id;
});
after(() => sequelize.close());

test("owner can reach everything", async () => {
  for (const path of [
    `/endpoints/${endpoint.id}`,
    `/endpoints/${endpoint.id}/events`,
    `/events/${eventId}`,
    `/events/${eventId}/body`,
  ])
    assert.strictEqual((await alice.get(`/api/v1${path}`)).status, 200, path);
});

test("another tenant gets 404 on every endpoint and event route", async () => {
  const attempts = [
    bob.get(`/api/v1/endpoints/${endpoint.id}`),
    bob.patch(`/api/v1/endpoints/${endpoint.id}`).send({ name: "hijack" }),
    bob.post(`/api/v1/endpoints/${endpoint.id}/rotate-slug`),
    bob.get(`/api/v1/endpoints/${endpoint.id}/events`),
    bob.get(`/api/v1/events/${eventId}`),
    bob.get(`/api/v1/events/${eventId}/body`),
    bob.delete(`/api/v1/endpoints/${endpoint.id}`),
  ];
  for (const res of await Promise.all(attempts)) {
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.code, "NOT_FOUND");
  }
  assert.deepStrictEqual((await bob.get("/api/v1/endpoints")).body, []);

  const intact = await alice.get(`/api/v1/endpoints/${endpoint.id}`);
  assert.strictEqual(intact.body.name, "private");
  assert.strictEqual(intact.body.slug, endpoint.slug);
  assert.strictEqual(
    (await alice.get(`/api/v1/events/${eventId}`)).status,
    200,
  );
});

test("unauthenticated requests get 401", async () => {
  const anon = request(app.callback());
  for (const path of [
    "/endpoints",
    `/endpoints/${endpoint.id}/events`,
    `/events/${eventId}`,
    `/events/${eventId}/body`,
  ])
    assert.strictEqual((await anon.get(`/api/v1${path}`)).status, 401, path);
});
