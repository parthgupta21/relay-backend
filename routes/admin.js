const crypto = require("node:crypto");
const Router = require("@koa/router");
const { Op } = require("sequelize");
const { z } = require("zod");
const {
  sequelize,
  ApiToken,
  AuditLog,
  Destination,
  Endpoint,
  Workspace,
} = require("../models");
const auth = require("../middleware/auth");
const requireOperator = require("../middleware/requireOperator");
const validate = require("../middleware/validate");
const { deleteWorkspace } = require("../services/account");
const { getUsage } = require("../services/usage");
const { AppError, sha256 } = require("../utils");

const router = new Router({ prefix: "/admin" });
router.use(auth, requireOperator);

const decodeCursor = (value) => {
  try {
    const { id } = JSON.parse(Buffer.from(value, "base64url").toString());
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
};

const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ id: row.id })).toString("base64url");

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .transform(decodeCursor)
    .refine(Boolean, "Invalid cursor")
    .optional(),
});

const paginate = async (model, { where, ...options }, { limit, cursor }) => {
  const rows = await model.findAll({
    ...options,
    where: cursor ? { ...where, id: { [Op.lt]: cursor } } : where,
    order: [["id", "DESC"]],
    limit: limit + 1,
  });
  return {
    rows: rows.slice(0, limit),
    nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]) : null,
  };
};

const auditInclude = [
  { association: "workspace", attributes: ["publicId"] },
  { association: "actor", attributes: ["email"] },
];

const notFound = () => new AppError("NOT_FOUND", 404, "Workspace not found");

const conflict = (message) => new AppError("CONFLICT", 409, message);

const findWorkspace = async (publicId, options) => {
  const workspace = await Workspace.findOne({
    where: { publicId },
    include: [{ association: "owner" }],
    ...options,
  });
  if (!workspace) throw notFound();
  return workspace;
};

const workspaceDetail = async (workspace) => {
  const { owner } = workspace;
  const [endpoints, destinations, apiTokens, audit, usage] = await Promise.all([
    Endpoint.count({ where: { workspaceId: workspace.id } }),
    Destination.count({
      include: [
        {
          association: "endpoint",
          required: true,
          where: { workspaceId: workspace.id },
        },
      ],
    }),
    ApiToken.count({ where: { workspaceId: workspace.id } }),
    AuditLog.findAll({
      where: { workspaceId: workspace.id },
      include: auditInclude,
      order: [["id", "DESC"]],
      limit: 20,
    }),
    getUsage(workspace).catch(() => null),
  ]);
  return {
    id: workspace.publicId,
    status: workspace.status,
    createdAt: workspace.createdAt,
    limits: workspace.limits(),
    owner: {
      id: owner.publicId,
      email: owner.email,
      emailVerified: Boolean(owner.emailVerifiedAt),
      isOperator: owner.isOperator,
      deletedAt: owner.deletedAt,
    },
    counts: { endpoints, destinations, apiTokens },
    usage,
    audit: audit.map((row) => row.present()),
  };
};

const patchBody = z
  .strictObject({
    status: z.enum(["active", "suspended"]),
    limits: z
      .strictObject({
        maxEndpoints: z.number().int().min(1).max(1000),
        maxDestinations: z.number().int().min(1).max(100),
        maxEventsPerDay: z.number().int().min(1).max(10_000_000),
        maxEventsPerMonth: z.number().int().min(1).max(100_000_000),
        maxBodyBytes: z.number().int().min(1024).max(10_485_760),
        retentionDays: z.number().int().min(1).max(90),
      })
      .partial()
      .refine((limits) => Object.keys(limits).length, "At least one limit"),
  })
  .partial()
  .refine((body) => Object.keys(body).length, "At least one key");

router.get(
  "/workspaces",
  validate({
    query: pageQuery.extend({
      q: z.string().trim().toLowerCase().min(1).max(255).optional(),
      status: z.enum(["active", "suspended", "deleted"]).optional(),
    }),
  }),
  async (ctx) => {
    const { q, status, ...paging } = ctx.state.query;
    const { rows, nextCursor } = await paginate(
      Workspace,
      {
        where: status && { status },
        attributes: {
          include: [
            [
              sequelize.literal(
                "(SELECT COUNT(*) FROM endpoints WHERE endpoints.workspace_id = Workspace.id)",
              ),
              "endpointCount",
            ],
          ],
        },
        include: [
          {
            association: "owner",
            required: true,
            where: q && {
              email: { [Op.like]: `${q.replace(/[\\%_]/g, "\\$&")}%` },
            },
          },
        ],
      },
      paging,
    );
    ctx.body = {
      items: rows.map((workspace) => ({
        id: workspace.publicId,
        status: workspace.status,
        ownerEmail: workspace.owner.email,
        ownerVerified: Boolean(workspace.owner.emailVerifiedAt),
        ownerIsOperator: workspace.owner.isOperator,
        endpointCount: Number(workspace.get("endpointCount")),
        createdAt: workspace.createdAt,
      })),
      nextCursor,
    };
  },
);

router.get(
  "/workspaces/:id",
  validate({ params: validate.idParams }),
  async (ctx) => {
    ctx.body = await workspaceDetail(await findWorkspace(ctx.state.params.id));
  },
);

router.patch(
  "/workspaces/:id",
  validate({ params: validate.idParams, body: patchBody }),
  async (ctx) => {
    const { status, limits } = ctx.state.body;
    const operator = ctx.state.user;
    const workspace = await sequelize.transaction(async (transaction) => {
      const target = await findWorkspace(ctx.state.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (target.status === "deleted") throw conflict("Workspace is deleted");
      const record = (action, meta) =>
        AuditLog.record(action, {
          workspaceId: target.id,
          actorUserId: operator.id,
          ip: ctx.ip,
          meta,
          transaction,
        });
      if (status) {
        if (target.ownerUserId === operator.id)
          throw conflict("Cannot change the status of your own workspace");
        if (status !== target.status) {
          await target.update({ status }, { transaction });
          await record(
            status === "suspended"
              ? "admin.workspace.suspended"
              : "admin.workspace.reactivated",
          );
        }
      }
      if (limits) {
        const current = target.limits();
        const changed = Object.keys(limits).filter(
          (key) => limits[key] !== current[key],
        );
        if (changed.length) {
          const pick = (source) =>
            Object.fromEntries(changed.map((key) => [key, source[key]]));
          await target.update(pick(limits), { transaction });
          await record("admin.workspace.limits_updated", {
            before: pick(current),
            after: pick(limits),
          });
        }
      }
      return target;
    });
    ctx.body = await workspaceDetail(workspace);
  },
);

router.post(
  "/workspaces/:id/delete",
  validate({
    params: validate.idParams,
    body: z.object({ confirm: z.string().min(1).max(255) }),
  }),
  async (ctx) => {
    const workspace = await findWorkspace(ctx.state.params.id);
    if (workspace.status === "deleted") throw conflict("Workspace is deleted");
    if (workspace.owner.isOperator)
      throw conflict("Cannot delete an operator's workspace");
    if (
      !crypto.timingSafeEqual(
        sha256(ctx.state.body.confirm),
        sha256(workspace.owner.email),
      )
    )
      throw new AppError("VALIDATION_FAILED", 422, "Confirmation mismatch", [
        { path: "body.confirm", message: "Does not match the owner email" },
      ]);
    await deleteWorkspace(workspace, {
      actorUserId: ctx.state.user.id,
      ip: ctx.ip,
      action: "admin.workspace.deleted",
    });
    ctx.status = 204;
  },
);

router.get(
  "/audit",
  validate({
    query: pageQuery.extend({
      workspaceId: z.string().min(1).max(30).optional(),
      action: z.string().min(1).max(64).optional(),
    }),
  }),
  async (ctx) => {
    const { workspaceId, action, ...paging } = ctx.state.query;
    const where = {};
    if (action) where.action = action;
    if (workspaceId) {
      const workspace = await Workspace.findOne({
        where: { publicId: workspaceId },
      });
      if (!workspace) throw notFound();
      where.workspaceId = workspace.id;
    }
    const { rows, nextCursor } = await paginate(
      AuditLog,
      {
        where,
        include: auditInclude,
      },
      paging,
    );
    ctx.body = { items: rows.map((row) => row.present()), nextCursor };
  },
);

module.exports = router;
