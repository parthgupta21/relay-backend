const retryDelay = (attempt, retryAfterMs = 0) => {
  const base = Number(process.env.RETRY_BASE_MS) || 30000;
  const cap = Number(process.env.RETRY_CAP_MS) || 3600000;
  const ceiling = Math.min(cap, base * 2 ** (attempt - 2));
  const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
  return Math.min(cap, Math.max(jittered, retryAfterMs));
};

const parseRetryAfter = (value, now = Date.now()) => {
  if (!value) return 0;
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return ms > 0 ? ms : 0;
};

module.exports = { retryDelay, parseRetryAfter };
