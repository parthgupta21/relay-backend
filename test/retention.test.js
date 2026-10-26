const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { sequelize, resetDatabase, signUp } = require("./helpers");
const {
  Delivery,
  DeliveryAttempt,
  Destination,
  Endpoint,
  Event,
  Workspace,
} = require("../models");
const { purgeExpired } = require("../services/retention");

const DAY_MS = 24 * 60 * 60 * 1000;

before(resetDatabase);
after(() => sequelize.close());

const seed = async (agent, name, ageDays) => {
  const endpoint = (await agent.post("/api/v1/endpoints").send({ name })).body;
  const destination = (
    await agent
      .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
      .send({ name, url: "http://93.184.216.34/hook" })
  ).body;
  const events = [];
  for (const age of ageDays) {
    const event = await Event.create({
      endpointId: (await Endpoint.findOne({ where: { publicId: endpoint.id } }))
        .id,
      method: "POST",
      path: "/",
      headers: {},
      bodySize: 0,
      sourceIp: Buffer.from([127, 0, 0, 1]),
      receivedAt: new Date(Date.now() - age * DAY_MS),
    });
    const delivery = await Delivery.create({
      eventId: event.id,
      destinationId: (
        await Destination.findOne({ where: { publicId: destination.id } })
      ).id,
      trigger: "auto",
      status: "succeeded",
      attemptCount: 1,
    });
    await DeliveryAttempt.create({
      deliveryId: delivery.id,
      attemptNo: 1,
      startedAt: new Date(),
      durationMs: 1,
      outcome: "success",
    });
    events.push(event);
  }
  return events;
};

test("events past retention are purged with deliveries and attempts, others kept", async () => {
  const shortAgent = await signUp("short@example.com");
  const longAgent = await signUp("long@example.com");
  await signUp("empty@example.com");
  const [shortWorkspace, longWorkspace] = await Workspace.findAll({
    order: [["id", "ASC"]],
  });
  await shortWorkspace.update({ retentionDays: 3 });
  await longWorkspace.update({ retentionDays: 30 });

  const [oldShort, freshShort] = await seed(shortAgent, "short", [5, 1]);
  const [oldLong, freshLong] = await seed(longAgent, "long", [10, 1]);

  assert.strictEqual(await purgeExpired(), 1);

  assert.strictEqual(await Event.findByPk(oldShort.id), null);
  assert.strictEqual(
    await Delivery.count({ where: { eventId: oldShort.id } }),
    0,
  );
  assert.ok(await Event.findByPk(freshShort.id));
  assert.ok(await Event.findByPk(oldLong.id));
  assert.ok(await Event.findByPk(freshLong.id));
  assert.strictEqual(await Delivery.count(), 3);
  assert.strictEqual(await DeliveryAttempt.count(), 3);
});

test("purges in batches until nothing is left", async () => {
  const [workspace] = await Workspace.findAll({ order: [["id", "ASC"]] });
  const endpoint = await Endpoint.findOne({
    where: { workspaceId: workspace.id },
  });
  await Event.bulkCreate(
    Array.from({ length: 1500 }, () => ({
      endpointId: endpoint.id,
      method: "POST",
      path: "/",
      headers: {},
      bodySize: 0,
      sourceIp: Buffer.from([127, 0, 0, 1]),
      receivedAt: new Date(Date.now() - 9 * DAY_MS),
    })),
  );
  assert.strictEqual(await purgeExpired(), 1500);
});

test("a deleted workspace is purged entirely regardless of retention", async () => {
  const goneAgent = await signUp("gone@example.com");
  await seed(goneAgent, "gone", [0, 1]);
  const gone = await Workspace.findOne({
    include: [{ association: "owner", where: { email: "gone@example.com" } }],
  });
  const counts = {
    events: await Event.count(),
    destinations: await Destination.count(),
    deliveries: await Delivery.count(),
    attempts: await DeliveryAttempt.count(),
  };
  await gone.update({ status: "deleted" });

  assert.strictEqual(await purgeExpired(), 2);

  assert.strictEqual(
    await Endpoint.count({ where: { workspaceId: gone.id } }),
    0,
  );
  assert.strictEqual(await Event.count(), counts.events - 2);
  assert.strictEqual(await Destination.count(), counts.destinations - 1);
  assert.strictEqual(await Delivery.count(), counts.deliveries - 2);
  assert.strictEqual(await DeliveryAttempt.count(), counts.attempts - 2);
  assert.strictEqual(await purgeExpired(), 0);
});
