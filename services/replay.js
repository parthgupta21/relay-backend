const { Delivery, Destination } = require("../models");
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
      "QUOTA_EXCEEDED",
      429,
      "Replay limit reached for this hour",
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
    include: [
      { model: Destination, as: "destination", paranoid: false },
      { model: Delivery, as: "replayOf" },
    ],
    order: [["id", "ASC"]],
  });
  return deliveries.map((delivery) => delivery.present());
};

module.exports = { createReplays };
