const Router = require("@koa/router");
const argon2 = require("argon2");
const { z } = require("zod");
const auth = require("../middleware/auth");
const rateLimit = require("../middleware/rateLimit");
const validate = require("../middleware/validate");
const { AuditLog } = require("../models");
const account = require("../services/account");
const { AppError } = require("../utils");

const router = new Router({ prefix: "/account" });
router.use(auth);

router.post(
  "/delete",
  rateLimit("account-delete", "ACCOUNT_DELETE_RATE_PER_MINUTE", 5),
  validate({ body: z.object({ password: z.string().min(1).max(256) }) }),
  async (ctx) => {
    const { user, workspace } = ctx.state;
    if (user.isOperator)
      throw new AppError(
        "FORBIDDEN",
        403,
        "Operators cannot delete their account",
      );
    if (!(await argon2.verify(user.passwordHash, ctx.state.body.password))) {
      await AuditLog.record("account.delete_failed", {
        workspaceId: workspace.id,
        actorUserId: user.id,
        ip: ctx.ip,
      });
      throw new AppError("VALIDATION_FAILED", 422, "Incorrect password", [
        { path: "body.password", message: "Incorrect password" },
      ]);
    }
    await account.deleteWorkspace(workspace, {
      actorUserId: user.id,
      ip: ctx.ip,
      action: "account.deleted",
    });
    ctx.cookies.set("relay_sid", null);
    ctx.status = 204;
  },
);

module.exports = router;
