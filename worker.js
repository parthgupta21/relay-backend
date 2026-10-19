require("dotenv").config({ quiet: true });
require("./logging");
const IORedis = require("ioredis");
const { Worker } = require("bullmq");
const sequelize = require("./database");
const { processJob } = require("./services/delivery");
const queue = require("./services/queue");
const { sweep } = require("./services/sweeper");
const { purgeExpired } = require("./services/retention");

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const worker = new Worker(queue.QUEUE_NAME, processJob, {
  connection,
  concurrency: Number(process.env.DELIVERY_CONCURRENCY) || 50,
  lockDuration: 60000,
});
worker.on("error", (err) => console.error("worker error", err.message));
worker.on("failed", (job, err) =>
  console.error(`job ${job?.id} failed`, err.stack || err),
);

const timers = [
  setInterval(
    () => sweep().catch((err) => console.error("sweep failed", err.message)),
    Number(process.env.SWEEPER_INTERVAL_MS) || 30000,
  ),
  setInterval(
    () =>
      purgeExpired()
        .then((purged) => purged && console.info(`retention purged=${purged}`))
        .catch((err) => console.error("retention failed", err.message)),
    Number(process.env.RETENTION_INTERVAL_MS) || 3600000,
  ),
];

const shutdown = async () => {
  timers.forEach(clearInterval);
  await worker.close();
  await queue.close();
  connection.disconnect();
  await sequelize.close();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.info(`worker started concurrency=${worker.opts.concurrency}`);
