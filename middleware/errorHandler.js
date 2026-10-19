const { ConnectionError } = require("sequelize");
const namespace = require("../namespace");
const { AppError } = require("../utils");

const toAppError = (err) => {
  if (err instanceof AppError) return err;
  if (err instanceof ConnectionError)
    return new AppError("SERVICE_UNAVAILABLE", 503, "Database unavailable");
  if (err.status === 413)
    return new AppError("PAYLOAD_TOO_LARGE", 413, "Payload too large");
  if (err.status >= 400 && err.status < 500)
    return new AppError("VALIDATION_FAILED", 422, "Invalid request body");
  console.error(err.stack || err);
  return new AppError("INTERNAL", 500, "Internal server error");
};

module.exports = async (ctx, next) => {
  try {
    await next();
    if (ctx.status === 404 && ctx.body == null)
      throw new AppError("NOT_FOUND", 404, "Not found");
  } catch (err) {
    const { code, status, message, details } = toAppError(err);
    ctx.status = status;
    ctx.body = {
      error: {
        code,
        message,
        ...(details && { details }),
        requestId: namespace.get("requestId"),
      },
    };
  }
};
