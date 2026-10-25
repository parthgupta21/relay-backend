const { Delivery } = require("../models");
const { connection, enqueueDeliveries } = require("./queue");
const { AppError } = require("../utils");

const HOURLY_LIMIT = 100;

const checkQuota = async (workspaceId) => {
  const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, "");
  const key = `replays:${workspaceId}:${hour}`;
  const [[, count]] = await connection
    .multi()
    .incr(key)
    .expire(key, 3600)
    .exec();
  if (count > HOURLY_LIMIT)
    throw new AppError(
      "RATE_LIMITED",
      429,
      "Replay limit reached for this hour",
      undefined,
      3600 - (Math.floor(Date.now() / 1000) % 3600),
    );
};

const createReplays = async (workspaceId, replays) => {
  await checkQuota(workspaceId);
  const created = await Delivery.bulkCreate(
    replays.map(({ eventId, destinationId, replayOfId = null }) => ({
      eventId,
      destinationId,
      replayOfId,
      trigger: "manual",
      status: "pending",
      nextAttemptAt: new Date(),
    })),
  );
  await enqueueDeliveries(created);
  const deliveries = await Delivery.findAll({
    where: { id: created.map(({ id }) => id) },
    include: Delivery.PRESENT_INCLUDE,
    order: [["id", "ASC"]],
  });
  return deliveries.map((delivery) => delivery.present());
};

module.exports = { createReplays };
