const { Session } = require("../models");
const { AppError } = require("../utils");

module.exports = async (ctx, next) => {
  const token = ctx.cookies.get("relay_sid");
  const session = token && (await Session.findActive(token));
  if (!session)
    throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
  ctx.state.user = session.user;
  ctx.state.workspace = session.user.workspace;
  ctx.state.session = session;
  return next();
};
