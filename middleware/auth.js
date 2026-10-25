const { ApiToken, Session } = require("../models");
const { AppError } = require("../utils");

const BEARER = /^Bearer\s+(\S+)$/i;
const LAST_USED_REFRESH_MS = 60 * 1000;

const assertActive = (workspace) => {
  if (workspace.status !== "active")
    throw new AppError("FORBIDDEN", 403, "Workspace not active");
};

const sessionAuth = async (ctx, next) => {
  const token = ctx.cookies.get("relay_sid");
  const session = token && (await Session.findActive(token));
  if (!session)
    throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
  assertActive(session.user.workspace);
  ctx.state.user = session.user;
  ctx.state.workspace = session.user.workspace;
  ctx.state.session = session;
  return next();
};

const bearerAuth = async (ctx, next, token) => {
  const apiToken = await ApiToken.findActive(token);
  if (!apiToken)
    throw new AppError("UNAUTHENTICATED", 401, "Invalid or expired API token");
  assertActive(apiToken.workspace);
  if (
    !apiToken.lastUsedAt ||
    Date.now() - apiToken.lastUsedAt > LAST_USED_REFRESH_MS
  )
    await apiToken.update({ lastUsedAt: new Date() });
  ctx.state.user = apiToken.workspace.owner;
  ctx.state.workspace = apiToken.workspace;
  ctx.state.apiToken = apiToken;
  return next();
};

module.exports = sessionAuth;

module.exports.withApiToken = (ctx, next) => {
  const match = ctx.get("Authorization").match(BEARER);
  return match ? bearerAuth(ctx, next, match[1]) : sessionAuth(ctx, next);
};
