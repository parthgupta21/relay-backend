const Router = require("@koa/router");
const { Op } = require("sequelize");
const { z } = require("zod");
const { Endpoint, Event, Delivery, Destination } = require("../models");
const auth = require("../middleware/auth");
const idempotency = require("../middleware/idempotency");
const requireVerified = require("../middleware/requireVerified");
const validate = require("../middleware/validate");
const { createReplays } = require("../services/replay");
const { AppError, bytesToIp } = require("../utils");

const router = new Router();
router.use(auth.withApiToken);

const params = z.object({ id: z.string().min(1).max(30) });

const decodeCursor = (value) => {
  try {
    const { receivedAt, id } = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    const date = new Date(receivedAt);
    return Number.isNaN(date.getTime()) || !Number.isInteger(id)
      ? null
      : { receivedAt: date, id };
  } catch {
    return null;
  }
};

const encodeCursor = (event) =>
  Buffer.from(
    JSON.stringify({
      receivedAt: event.receivedAt.toISOString(),
      id: event.id,
    }),
  ).toString("base64url");

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .transform(decodeCursor)
    .refine(Boolean, "Invalid cursor")
    .optional(),
  method: z.string().trim().toUpperCase().min(1).max(10).optional(),
});

router.get(
  "/endpoints/:id/events",
  validate({ params, query: listQuery }),
  async (ctx) => {
    const endpoint = await Endpoint.getOwned(
      ctx.state.workspace.id,
      ctx.state.params.id,
    );
    const { limit, cursor, method } = ctx.state.query;
    const where = { endpointId: endpoint.id };
    if (method) where.method = method;
    if (cursor)
      where[Op.or] = [
        { receivedAt: { [Op.lt]: cursor.receivedAt } },
        { receivedAt: cursor.receivedAt, id: { [Op.lt]: cursor.id } },
      ];
    const rows = await Event.findAll({
      where,
      attributes: [
        "id",
        "publicId",
        "method",
        "path",
        "contentType",
        "bodySize",
        "sourceIp",
        "receivedAt",
      ],
      order: [
        ["receivedAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    ctx.body = {
      items: page.map((event) => ({
        id: event.publicId,
        method: event.method,
        path: event.path,
        contentType: event.contentType,
        bodySize: event.bodySize,
        sourceIp: bytesToIp(event.sourceIp),
        receivedAt: event.receivedAt,
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[limit - 1]) : null,
    };
  },
);

router.get("/events/:id", validate({ params }), async (ctx) => {
  const event = await Event.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  ctx.body = {
    id: event.publicId,
    endpointId: event.endpoint.publicId,
    method: event.method,
    path: event.path,
    queryString: event.queryString,
    headers: event.headers,
    contentType: event.contentType,
    bodySize: event.bodySize,
    sourceIp: bytesToIp(event.sourceIp),
    receivedAt: event.receivedAt,
    idempotencyKey: event.idempotencyKey,
    body: event.body ? event.body.toString("base64") : null,
    bodyJson: event.bodyJson,
    deliveries: (
      await Delivery.findAll({
        where: { eventId: event.id },
        include: [
          { model: Destination, as: "destination", paranoid: false },
          { model: Delivery, as: "replayOf" },
        ],
        order: [["id", "ASC"]],
      })
    ).map((delivery) => delivery.present()),
  };
});

router.post(
  "/events/:id/replay",
  requireVerified,
  validate({
    params,
    body: z.object({
      destinationIds: z.array(z.string().min(1).max(30)).max(100).optional(),
    }),
  }),
  idempotency,
  async (ctx) => {
    const workspaceId = ctx.state.workspace.id;
    const event = await Event.getOwned(workspaceId, ctx.state.params.id);
    const { destinationIds } = ctx.state.body;
    const destinations = await Destination.findAll({
      where: {
        endpointId: event.endpointId,
        isActive: true,
        ...(destinationIds && { publicId: destinationIds }),
      },
      order: [["id", "ASC"]],
    });
    if (destinationIds && destinations.length !== new Set(destinationIds).size)
      throw new AppError(
        "VALIDATION_FAILED",
        422,
        "Destinations must be active and belong to the event's endpoint",
        [
          {
            path: "body.destinationIds",
            message: "Unknown or inactive destination",
          },
        ],
      );
    const deliveries = await createReplays(
      workspaceId,
      destinations.map((destination) => ({
        eventId: event.id,
        destinationId: destination.id,
      })),
    );
    ctx.status = 202;
    ctx.body = { deliveries };
  },
);

router.get("/events/:id/body", validate({ params }), async (ctx) => {
  const event = await Event.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  ctx.set("Content-Type", event.contentType || "application/octet-stream");
  ctx.set(
    "Content-Disposition",
    `attachment; filename="${event.publicId}.bin"`,
  );
  ctx.set("X-Content-Type-Options", "nosniff");
  ctx.body = event.body || Buffer.alloc(0);
});

module.exports = router;
