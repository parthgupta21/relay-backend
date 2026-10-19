require("dotenv").config({ quiet: true });
require("./logging");
const crypto = require("crypto");
const Koa = require("koa");
const Router = require("@koa/router");
const namespace = require("./namespace");
const sequelize = require("./database");
const errorHandler = require("./middleware/errorHandler");
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

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.info(
      `relay listening on ${port} role=${process.env.ROLE || "all"}`,
    ),
  );
}

module.exports = app;
