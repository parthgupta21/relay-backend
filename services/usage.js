const { connection } = require("./queue");
const { AppError } = require("../utils");

const PREFIX = process.env.NODE_ENV === "test" ? "test:" : "";
const TTL = 40 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 31;

const stamp = (date) => date.toISOString().replace(/\D/g, "");

const usageKey = (workspaceId, kind, period) =>
  `${PREFIX}usage:${workspaceId}:${kind}:${period}`;

const startOfMonth = (now, offset = 0) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1);

const tooMany = (code, message, retryAfter) =>
  new AppError(code, 429, message, undefined, retryAfter);

const unavailable = () =>
  new AppError("SERVICE_UNAVAILABLE", 503, "Usage unavailable");

const ratePerMinute = () => Number(process.env.INGEST_RATE_PER_MINUTE) || 600;

const limitIngest = async ({ id, workspaceId, workspace }) => {
  if (connection.status !== "ready")
    return console.warn("rate limit skipped, redis not ready");
  const now = new Date();
  const time = stamp(now);
  const rateKey = `${PREFIX}rl:ep:${id}:${time.slice(0, 12)}`;
  const results = await connection
    .multi()
    .incr(rateKey)
    .expire(rateKey, 60)
    .get(usageKey(workspaceId, "events", time.slice(0, 6)))
    .get(usageKey(workspaceId, "events", time.slice(0, 8)))
    .exec()
    .catch((err) => console.warn("rate limit failed", err.message));
  if (!results) return;
  const [[, rate], , [, monthEvents], [, dayEvents]] = results;
  if (rate > ratePerMinute())
    throw tooMany(
      "RATE_LIMITED",
      "Rate limit exceeded",
      60 - now.getUTCSeconds(),
    );
  if (Number(monthEvents) >= workspace.maxEventsPerMonth)
    throw tooMany(
      "QUOTA_EXCEEDED",
      "Monthly event quota reached",
      Math.ceil((startOfMonth(now, 1) - now) / 1000),
    );
  if (Number(dayEvents) >= workspace.maxEventsPerDay)
    throw tooMany(
      "QUOTA_EXCEEDED",
      "Daily event quota reached",
      Math.ceil((DAY_MS - (now % DAY_MS)) / 1000),
    );
};

const recordUsage = async (workspaceId, kind) => {
  if (connection.status !== "ready")
    return console.warn("usage skipped, redis not ready");
  const time = stamp(new Date());
  const keys = [usageKey(workspaceId, kind, time.slice(0, 8))];
  if (kind === "events")
    keys.push(usageKey(workspaceId, kind, time.slice(0, 6)));
  const multi = connection.multi();
  for (const key of keys) multi.incr(key).expire(key, TTL);
  await multi.exec().catch((err) => console.warn("usage failed", err.message));
};

const getUsage = async (workspace) => {
  if (connection.status !== "ready") throw unavailable();
  const now = new Date();
  const dates = Array.from(
    { length: DAYS },
    (_, i) => new Date(now - (DAYS - 1 - i) * DAY_MS),
  );
  const periods = dates.map((date) => stamp(date).slice(0, 8));
  const values = await connection
    .mget(
      ...periods.map((period) => usageKey(workspace.id, "events", period)),
      ...periods.map((period) => usageKey(workspace.id, "deliveries", period)),
      usageKey(workspace.id, "events", stamp(now).slice(0, 6)),
    )
    .catch(() => {
      throw unavailable();
    });
  const days = dates.map((date, i) => ({
    date: date.toISOString().slice(0, 10),
    events: Number(values[i]),
    deliveries: Number(values[DAYS + i]),
  }));
  const start = new Date(startOfMonth(now)).toISOString();
  return {
    month: {
      start,
      resetsAt: new Date(startOfMonth(now, 1)).toISOString(),
      events: Number(values[2 * DAYS]),
      eventsLimit: workspace.maxEventsPerMonth,
      deliveries: days
        .filter(({ date }) => date >= start.slice(0, 10))
        .reduce((sum, day) => sum + day.deliveries, 0),
    },
    today: { ...days[DAYS - 1], eventsLimit: workspace.maxEventsPerDay },
    rateLimit: { perEndpointPerMinute: ratePerMinute() },
    days,
  };
};

module.exports = {
  PREFIX,
  stamp,
  tooMany,
  limitIngest,
  recordUsage,
  getUsage,
};
