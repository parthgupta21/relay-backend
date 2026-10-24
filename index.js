require("dotenv").config({ quiet: true });
require("./logging");
const crypto = require("crypto");
const Koa = require("koa");
const Router = require("@koa/router");
const bodyParser = require("koa-bodyparser");
const originCheck = require("./middleware/originCheck");
const authRoutes = require("./routes/auth");
const endpointRoutes = require("./routes/endpoints");
const eventRoutes = require("./routes/events");
const destinationRoutes = require("./routes/destinations");
const deliveryRoutes = require("./routes/deliveries");
const ingestRoutes = require("./routes/ingest");
const namespace = require("./namespace");
const sequelize = require("./database");
const { Destination } = require("./models");
const queue = require("./services/queue");
const errorHandler = require("./middleware/errorHandler");
const realtime = require("./services/realtime");

const app = new Koa();
app.proxy = process.env.TRUST_PROXY === "true";
app.maxIpsCount = 1;

app.use((ctx, next) =>
  namespace.runAndReturn(() => {
    const header = ctx.get("X-Request-Id");
    const requestId = /^[\w-]{1,64}$/.test(header)
      ? header
      : crypto.randomUUID();
    namespace.set("requestId", requestId);
    namespace.set("ctx", ctx);
    ctx.set("X-Request-Id", requestId);
    return next();
  }),
);
app.use(errorHandler);

const health = new Router();
health.get("/healthz", (ctx) => {
  ctx.body = { ok: true };
});
health.get("/readyz", async (ctx) => {
  await sequelize.authenticate();
  ctx.body = { ok: true };
});
app.use(health.routes());

const role = process.env.ROLE || "all";

if (role !== "ingest") {
  const api = new Router({ prefix: "/api/v1" });
  api.use(
    originCheck,
    bodyParser({ enableTypes: ["json"], jsonLimit: "100kb" }),
  );
  api.use(authRoutes.routes());
  api.use(endpointRoutes.routes());
  api.use(eventRoutes.routes());
  api.use(destinationRoutes.routes());
  api.use(deliveryRoutes.routes());
  app.use(api.routes());
}

if (role !== "app") app.use(ingestRoutes.routes());

if (require.main === module) {
  Destination.assertEncryptionKey();
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () =>
    console.info(`relay listening on ${port} role=${role}`),
  );
  const sockets = role !== "ingest" ? realtime.attach(server) : null;
  process.once("SIGTERM", () => {
    setTimeout(() => process.exit(1), 10000).unref();
    server.close(() =>
      queue
        .close()
        .then(() => sequelize.close())
        .catch((err) => {
          console.error("shutdown failed", err.message);
          process.exit(1);
        }),
    );
    sockets?.close();
  });
}

module.exports = app;
