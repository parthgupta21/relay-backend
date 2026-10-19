const { Op } = require("sequelize");
const { Delivery, Destination } = require("../models");
const { enqueueDeliveries } = require("./queue");

const BATCH = 500;
const MISSED_AFTER_MS = 60000;

const resetStuck = async (delivery, now) => {
  const exhausted = delivery.attemptCount >= delivery.destination.maxAttempts;
  const [changed] = await Delivery.update(
    exhausted
      ? {
          status: "failed",
          failureReason: "exhausted",
          lockedUntil: null,
          completedAt: now,
        }
      : { status: "retry_scheduled", nextAttemptAt: now, lockedUntil: null },
    {
      where: {
        id: delivery.id,
        status: "in_flight",
        lockedUntil: delivery.lockedUntil,
      },
    },
  );
  if (!changed || exhausted) return false;
  delivery.nextAttemptAt = now;
  return true;
};

const sweep = async () => {
  const now = new Date();
  const deliveries = await Delivery.findAll({
    where: {
      [Op.or]: [
        {
          status: ["pending", "retry_scheduled"],
          nextAttemptAt: { [Op.lt]: new Date(now - MISSED_AFTER_MS) },
        },
        { status: "in_flight", lockedUntil: { [Op.lt]: now } },
      ],
    },
    include: [{ model: Destination, as: "destination", paranoid: false }],
    limit: BATCH,
  });
  const toEnqueue = [];
  for (const delivery of deliveries)
    if (delivery.status !== "in_flight" || (await resetStuck(delivery, now)))
      toEnqueue.push(delivery);
  if (toEnqueue.length) await enqueueDeliveries(toEnqueue);
  return deliveries.length;
};

module.exports = { sweep };
