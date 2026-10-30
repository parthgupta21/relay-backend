const { connection } = require("../services/queue");
const { PREFIX, stamp, tooMany } = require("../services/usage");

const rateLimit = (name, envVar, fallback) => async (ctx, next) => {
  if (connection.status !== "ready") {
    console.warn("rate limit skipped, redis not ready");
    return next();
  }
  const now = new Date();
  const key = `${PREFIX}rl:${name}:${ctx.ip}:${stamp(now).slice(0, 12)}`;
  const results = await connection
    .multi()
    .incr(key)
    .expire(key, 60)
    .exec()
    .catch((err) => console.warn("rate limit failed", err.message));
  if (results && results[0][1] > (Number(process.env[envVar]) || fallback))
    throw tooMany(
      "RATE_LIMITED",
      "Rate limit exceeded",
      60 - now.getUTCSeconds(),
    );
  return next();
};

module.exports = rateLimit;
