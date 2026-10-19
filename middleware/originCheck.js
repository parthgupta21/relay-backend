const { AppError } = require("../utils");

const UNSAFE_METHODS = ["POST", "PATCH", "DELETE"];

module.exports = (ctx, next) => {
  const origin = ctx.get("Origin");
  if (
    UNSAFE_METHODS.includes(ctx.method) &&
    origin &&
    origin !== new URL(process.env.APP_BASE_URL).origin
  )
    throw new AppError("FORBIDDEN", 403, "Origin not allowed");
  return next();
};
