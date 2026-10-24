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

const sweepOnce = async () => {
  const now = new Date();
  let afterId = 0;
  let swept = 0;
  for (;;) {
    const deliveries = await Delivery.findAll({
      where: {
        id: { [Op.gt]: afterId },
        [Op.or]: [
          {
            status: ["pending", "retry_scheduled"],
            nextAttemptAt: { [Op.lt]: new Date(now - MISSED_AFTER_MS) },
          },
          { status: "in_flight", lockedUntil: { [Op.lt]: now } },
        ],
      },
      include: [{ model: Destination, as: "destination", paranoid: false }],
      order: [["id", "ASC"]],
      limit: BATCH,
    });
    if (!deliveries.length) return swept;
    const toEnqueue = [];
    for (const delivery of deliveries)
      if (delivery.status !== "in_flight" || (await resetStuck(delivery, now)))
        toEnqueue.push(delivery);
    if (toEnqueue.length) await enqueueDeliveries(toEnqueue);
    afterId = deliveries[deliveries.length - 1].id;
    swept += deliveries.length;
  }
};

let running = false;

const sweep = async () => {
  if (running) return 0;
  running = true;
  try {
    return await sweepOnce();
  } finally {
    running = false;
  }
};

module.exports = { sweep };
