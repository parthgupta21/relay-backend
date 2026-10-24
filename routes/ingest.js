const Router = require("@koa/router");
const { getRawBody } = require("raw-body");
const { UniqueConstraintError } = require("sequelize");
const {
  sequelize,
  Endpoint,
  Event,
  Destination,
  Delivery,
} = require("../models");
const { enqueueDeliveries } = require("../services/queue");
const { publish } = require("../services/realtime");
const { AppError, ipToBytes } = require("../utils");

const router = new Router();

router.all("/h/:slug{/*rest}", async (ctx) => {
  const { slug } = ctx.params;
  const endpoint = await Endpoint.findOne({
    where: { slug, isActive: true },
    include: [
      { association: "workspace", where: { status: "active" }, required: true },
    ],
  });
  if (!endpoint) throw new AppError("NOT_FOUND", 404, "Not found");

  const raw = await getRawBody(ctx.req, {
    limit: endpoint.workspace.maxBodyBytes,
  }).catch((err) => {
    if (err.type === "entity.too.large")
      throw new AppError("PAYLOAD_TOO_LARGE", 413, "Payload too large");
    throw err;
  });

  const contentType = ctx.get("content-type") || null;
  let bodyJson = null;
  if (raw.length && contentType && /json/i.test(contentType)) {
    try {
      bodyJson = JSON.parse(raw.toString("utf8"));
    } catch {
      bodyJson = null;
    }
  }
  const idempotencyKey = endpoint.idempotencyHeader
    ? ctx.get(endpoint.idempotencyHeader).slice(0, 255) || null
    : null;

  try {
    const { event, deliveries } = await sequelize.transaction(
      async (transaction) => {
        const event = await Event.create(
          {
            endpointId: endpoint.id,
            method: ctx.method,
            path: ctx.path.slice(`/h/${slug}`.length).slice(0, 2048) || "/",
            queryString: ctx.querystring || null,
            headers: ctx.headers,
            contentType: contentType && contentType.slice(0, 255),
            body: raw.length ? raw : null,
            bodyJson,
            bodySize: raw.length,
            sourceIp: ipToBytes(ctx.ip),
            idempotencyKey,
            receivedAt: new Date(),
          },
          { transaction },
        );
        const destinations = await Destination.findAll({
          where: { endpointId: endpoint.id, isActive: true },
          transaction,
        });
        const deliveries = await Delivery.bulkCreate(
          destinations.map((destination) => ({
            eventId: event.id,
            destinationId: destination.id,
            trigger: "auto",
            status: "pending",
            nextAttemptAt: new Date(),
          })),
          { transaction },
        );
        return { event, deliveries };
      },
    );
    await publish(endpoint.workspace.id, "event.created", {
      endpointId: endpoint.publicId,
      eventId: event.publicId,
    });
    if (deliveries.length) await enqueueDeliveries(deliveries);
    ctx.body = { id: event.publicId, duplicate: false };
  } catch (err) {
    if (!(err instanceof UniqueConstraintError) || !idempotencyKey) throw err;
    const existing = await Event.findOne({
      where: { endpointId: endpoint.id, idempotencyKey },
      attributes: ["publicId"],
    });
    ctx.body = { id: existing.publicId, duplicate: true };
  }
});

module.exports = router;
