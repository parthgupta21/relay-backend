const { connection } = require("../services/queue");
const { AppError, sha256 } = require("../utils");

const TTL_SECONDS = 24 * 60 * 60;

module.exports = async (ctx, next) => {
  const key = ctx.get("Idempotency-Key");
  if (!key || key.length > 255)
    throw new AppError(
      "VALIDATION_FAILED",
      422,
      "Idempotency-Key header is required and must be at most 255 characters",
      [
        {
          path: "headers.idempotency-key",
          message: "Required, at most 255 characters",
        },
      ],
    );
  if (connection.status !== "ready")
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      503,
      "Idempotency store unavailable",
    );
  const redisKey = `idem:${ctx.state.workspace.id}:${key}`;
  const fingerprint = sha256(
    `${ctx.method} ${ctx.path}\n${JSON.stringify(ctx.request.body)}`,
  ).toString("hex");

  const reserved = await connection.set(
    redisKey,
    JSON.stringify({ fingerprint }),
    "EX",
    TTL_SECONDS,
    "NX",
  );
  if (!reserved) {
    const stored = JSON.parse(await connection.get(redisKey));
    if (stored && stored.fingerprint !== fingerprint)
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        422,
        "Idempotency-Key was already used with a different request",
      );
    if (!stored?.response)
      throw new AppError(
        "CONFLICT",
        409,
        "A request with this key is in progress",
      );
    ctx.status = stored.response.status;
    ctx.body = stored.response.body;
    return;
  }

  try {
    await next();
  } catch (err) {
    await connection.del(redisKey);
    throw err;
  }
  await connection.set(
    redisKey,
    JSON.stringify({
      fingerprint,
      response: { status: ctx.status, body: ctx.body },
    }),
    "EX",
    TTL_SECONDS,
  );
};
