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
const errorHandler = require("./middleware/errorHandler");
const realtime = require("./services/realtime");
const { AppError } = require("./utils");

const app = new Koa();
app.proxy = process.env.TRUST_PROXY === "true";

app.use((ctx, next) =>
  namespace.runAndReturn(() => {
    const requestId = ctx.get("X-Request-Id") || crypto.randomUUID();
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
  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error("readyz failed", err.message);
    throw new AppError("SERVICE_UNAVAILABLE", 503, "Database unavailable");
  }
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
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () =>
    console.info(`relay listening on ${port} role=${role}`),
  );
  if (role !== "ingest") realtime.attach(server);
}

module.exports = app;
