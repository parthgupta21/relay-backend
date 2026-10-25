const Router = require("@koa/router");
const { z } = require("zod");
const { ApiToken, AuditLog } = require("../models");
const auth = require("../middleware/auth");
const requireVerified = require("../middleware/requireVerified");
const validate = require("../middleware/validate");
const { AppError } = require("../utils");

const router = new Router({ prefix: "/tokens" });
router.use(auth);

const params = z.object({ id: z.string().min(1).max(30) });

const audit = (ctx, action, apiToken) =>
  AuditLog.record(action, {
    workspaceId: ctx.state.workspace.id,
    actorUserId: ctx.state.user.id,
    ip: ctx.ip,
    meta: {
      tokenId: apiToken.publicId,
      name: apiToken.name,
      prefix: apiToken.prefix,
    },
  });

router.get("/", async (ctx) => {
  const apiTokens = await ApiToken.findAll({
    where: { workspaceId: ctx.state.workspace.id },
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });
  ctx.body = apiTokens.map((apiToken) => apiToken.present());
});

router.post(
  "/",
  requireVerified,
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(100),
      expiresInDays: z.number().int().min(1).max(365).optional(),
    }),
  }),
  async (ctx) => {
    const workspaceId = ctx.state.workspace.id;
    if (
      (await ApiToken.count({ where: { workspaceId } })) >=
      ApiToken.MAX_PER_WORKSPACE
    )
      throw new AppError("QUOTA_EXCEEDED", 422, "API token limit reached");
    const { apiToken, token } = await ApiToken.issue(
      workspaceId,
      ctx.state.body,
    );
    await audit(ctx, "token.created", apiToken);
    ctx.status = 201;
    ctx.body = { ...apiToken.present(), token };
  },
);

router.delete("/:id", validate({ params }), async (ctx) => {
  const apiToken = await ApiToken.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  await apiToken.destroy();
  await audit(ctx, "token.revoked", apiToken);
  ctx.status = 204;
});

module.exports = router;
