const IORedis = require("ioredis");
const { Queue } = require("bullmq");

const QUEUE_NAME =
  process.env.NODE_ENV === "test" ? "deliveries-test" : "deliveries";

const connection = new IORedis(process.env.REDIS_URL, {
  enableOfflineQueue: false,
});
connection.on("error", (err) => console.warn("redis error", err.message));

const queue = new Queue(QUEUE_NAME, { connection });
queue.on("error", (err) => console.warn("queue error", err.message));

const enqueueDeliveries = async (deliveries) => {
  if (connection.status !== "ready")
    return console.warn("enqueue skipped, redis not ready");
  await queue
    .addBulk(
      deliveries.map(({ id, attemptCount, nextAttemptAt }) => ({
        name: "deliver",
        data: { deliveryId: id },
        opts: {
          jobId: `d${id}-a${attemptCount + 1}`,
          delay: Math.max(0, nextAttemptAt - Date.now()),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    )
    .catch((err) => console.warn("enqueue failed", err.message));
};

const close = async () => {
  await queue.close();
  connection.disconnect();
};

module.exports = { QUEUE_NAME, enqueueDeliveries, close };
