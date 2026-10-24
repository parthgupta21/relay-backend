const { AppError } = require("../utils");

const UNSAFE_METHODS = ["POST", "PATCH", "DELETE"];

const isAllowedOrigin = (origin) =>
  !origin || origin === new URL(process.env.APP_BASE_URL).origin;

module.exports = (ctx, next) => {
  if (
    UNSAFE_METHODS.includes(ctx.method) &&
    !isAllowedOrigin(ctx.get("Origin"))
  )
    throw new AppError("FORBIDDEN", 403, "Origin not allowed");
  return next();
};

module.exports.isAllowedOrigin = isAllowedOrigin;
