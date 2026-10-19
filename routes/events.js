const Router = require("@koa/router");
const { Op } = require("sequelize");
const { z } = require("zod");
const { Endpoint, Event, Delivery, Destination } = require("../models");
const auth = require("../middleware/auth");
const validate = require("../middleware/validate");
const { bytesToIp } = require("../utils");

const router = new Router();
router.use(auth);

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
        include: [{ model: Destination, as: "destination", paranoid: false }],
        order: [["id", "ASC"]],
      })
    ).map((delivery) => delivery.present()),
  };
});

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
