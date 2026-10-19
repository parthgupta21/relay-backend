require("dotenv").config({ quiet: true });
require("./logging");
const IORedis = require("ioredis");
const { Worker } = require("bullmq");
const sequelize = require("./database");
const { processDelivery } = require("./services/delivery");
const queue = require("./services/queue");

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  queue.QUEUE_NAME,
  (job) => processDelivery(job.data.deliveryId),
  {
    connection,
    concurrency: Number(process.env.DELIVERY_CONCURRENCY) || 50,
    lockDuration: 60000,
  },
);
worker.on("error", (err) => console.error("worker error", err.message));
worker.on("failed", (job, err) =>
  console.error(`job ${job?.id} failed`, err.stack || err),
);

const shutdown = async () => {
  await worker.close();
  await queue.close();
  connection.disconnect();
  await sequelize.close();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.info(`worker started concurrency=${worker.opts.concurrency}`);
