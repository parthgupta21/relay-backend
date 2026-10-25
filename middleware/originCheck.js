const { AppError } = require("../utils");

const BEARER = /^Bearer\s+\S+$/i;
const UNSAFE_METHODS = ["POST", "PATCH", "DELETE"];

const isAllowedOrigin = (origin) =>
  !origin || origin === new URL(process.env.APP_BASE_URL).origin;

module.exports = (ctx, next) => {
  if (
    UNSAFE_METHODS.includes(ctx.method) &&
    !(BEARER.test(ctx.get("Authorization")) && !ctx.cookies.get("relay_sid")) &&
    !isAllowedOrigin(ctx.get("Origin"))
  )
    throw new AppError("FORBIDDEN", 403, "Origin not allowed");
  return next();
};

module.exports.isAllowedOrigin = isAllowedOrigin;
