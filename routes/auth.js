const Router = require("@koa/router");
const { z } = require("zod");
const { sequelize, User, Session, EmailToken, AuditLog } = require("../models");
const auth = require("../middleware/auth");
const validate = require("../middleware/validate");
const email = require("../services/email");
const { AppError } = require("../utils");

const router = new Router({ prefix: "/auth" });

const emailField = z.string().trim().toLowerCase().pipe(z.email().max(255));
const newPassword = z.string().min(10).max(256);
const tokenField = z.string().min(1).max(200);

const CHECK_INBOX = { message: "Check your inbox to verify your email." };

const me = (user, workspace) => ({
  user: {
    id: user.publicId,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
  },
  workspace: {
    id: workspace.publicId,
    status: workspace.status,
    limits: workspace.limits(),
  },
});

const startSession = async (ctx, user) => {
  const token = await Session.start(user.id);
  ctx.cookies.set("relay_sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Session.TTL_MS,
  });
};

router.post(
  "/register",
  validate({ body: z.object({ email: emailField, password: newPassword }) }),
  async (ctx) => {
    const { email: address, password } = ctx.state.body;
    const created = await User.register(address, password);
    if (created) await email.sendVerification(address, created.token);
    else await email.sendSignupAttempt(address);
    ctx.status = 202;
    ctx.body = CHECK_INBOX;
  },
);

router.post(
  "/verify-email",
  validate({ body: z.object({ token: tokenField }) }),
  async (ctx) => {
    const userId = await sequelize.transaction(async (transaction) => {
      const id = await EmailToken.consume(
        ctx.state.body.token,
        "verify",
        transaction,
      );
      if (!id)
        throw new AppError(
          "VALIDATION_FAILED",
          422,
          "Invalid or expired token",
        );
      await User.update(
        { emailVerifiedAt: new Date() },
        { where: { id }, transaction },
      );
      return id;
    });
    const user = await User.findByPk(userId, {
      include: [{ association: "workspace" }],
    });
    await startSession(ctx, user);
    ctx.body = me(user, user.workspace);
  },
);

router.post(
  "/resend-verification",
  validate({ body: z.object({ email: emailField }) }),
  async (ctx) => {
    const user = await User.findOne({
      where: { email: ctx.state.body.email, emailVerifiedAt: null },
    });
    if (user)
      await email.sendVerification(
        user.email,
        await EmailToken.issue(user.id, "verify"),
      );
    ctx.status = 202;
    ctx.body = CHECK_INBOX;
  },
);

router.post(
  "/login",
  validate({
    body: z.object({ email: emailField, password: z.string().min(1).max(256) }),
  }),
  async (ctx) => {
    const { email: address, password } = ctx.state.body;
    const user = await User.authenticate(address, password);
    if (!user) {
      await AuditLog.record("login.failed", { ip: ctx.ip });
      throw new AppError("UNAUTHENTICATED", 401, "Invalid email or password");
    }
    const workspace = await user.getWorkspace();
    await startSession(ctx, user);
    await AuditLog.record("login", {
      workspaceId: workspace.id,
      actorUserId: user.id,
      ip: ctx.ip,
    });
    ctx.body = me(user, workspace);
  },
);

router.post("/logout", auth, async (ctx) => {
  await ctx.state.session.destroy();
  ctx.cookies.set("relay_sid", null);
  ctx.status = 204;
});

router.post(
  "/forgot-password",
  validate({ body: z.object({ email: emailField }) }),
  async (ctx) => {
    const user = await User.findOne({
      where: { email: ctx.state.body.email, deletedAt: null },
    });
    if (user)
      await email.sendPasswordReset(
        user.email,
        await EmailToken.issue(user.id, "reset"),
      );
    ctx.status = 202;
    ctx.body = { message: "If the account exists, a reset link was sent." };
  },
);

router.post(
  "/reset-password",
  validate({ body: z.object({ token: tokenField, password: newPassword }) }),
  async (ctx) => {
    const { token, password } = ctx.state.body;
    const user = await sequelize.transaction(async (transaction) => {
      const id = await EmailToken.consume(token, "reset", transaction);
      if (!id)
        throw new AppError(
          "VALIDATION_FAILED",
          422,
          "Invalid or expired token",
        );
      const found = await User.findByPk(id, { transaction });
      await found.setPassword(password, transaction);
      await Session.destroy({ where: { userId: id }, transaction });
      return found;
    });
    await AuditLog.record("password.reset", {
      actorUserId: user.id,
      ip: ctx.ip,
    });
    ctx.status = 204;
  },
);

router.get("/me", auth, (ctx) => {
  ctx.body = me(ctx.state.user, ctx.state.workspace);
});

module.exports = router;
