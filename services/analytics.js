const { QueryTypes } = require("sequelize");
const sequelize = require("../database");

const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;
const RANGES = {
  "24h": { bucket: "hour", count: 24, size: HOUR_S },
  "7d": { bucket: "day", count: 7, size: DAY_S },
};

const FROM = `FROM deliveries d
JOIN destinations ds ON ds.id = d.destination_id
JOIN endpoints e ON e.id = ds.endpoint_id`;
const ATTEMPTS = "JOIN delivery_attempts a ON a.delivery_id = d.id";

const sqlTime = (seconds) =>
  new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");

const sum = (values) => values.reduce((total, value) => total + value, 0);

const getDeliveryAnalytics = async (workspace, range, endpointId) => {
  const { bucket, count, size } = RANGES[range];
  const to = (Math.floor(Date.now() / 1000 / size) + 1) * size;
  const from = to - count * size;
  const where = `WHERE e.workspace_id = :workspaceId
AND d.created_at >= :from AND d.created_at < :to${endpointId ? " AND e.id = :endpointId" : ""}`;
  const select = (sql) =>
    sequelize.query(sql, {
      replacements: {
        workspaceId: workspace.id,
        endpointId,
        size,
        from: sqlTime(from),
        to: sqlTime(to),
      },
      type: QueryTypes.SELECT,
    });

  const [statuses, destinations, attempts, [percentiles]] = await Promise.all([
    select(`SELECT TIMESTAMPDIFF(SECOND, :from, d.created_at) DIV :size AS bucket,
d.status, d.failure_reason AS failureReason, COUNT(*) AS n
${FROM} ${where}
GROUP BY bucket, d.status, d.failure_reason`),
    select(`SELECT ds.public_id AS id, ds.name, ds.deleted_at IS NOT NULL AS deleted,
COUNT(*) AS deliveries,
SUM(d.status = 'succeeded') AS succeeded, SUM(d.status = 'failed') AS failed
${FROM} ${where}
GROUP BY ds.id, ds.public_id, ds.name, ds.deleted_at
ORDER BY deliveries DESC, ds.id
LIMIT 10`),
    select(`SELECT a.outcome, COUNT(*) AS n
${FROM} ${ATTEMPTS} ${where}
GROUP BY a.outcome`),
    select(`SELECT MIN(CASE WHEN cd >= 0.5 THEN duration_ms END) AS p50Ms,
MIN(CASE WHEN cd >= 0.95 THEN duration_ms END) AS p95Ms
FROM (
SELECT a.duration_ms, CUME_DIST() OVER (ORDER BY a.duration_ms) AS cd
${FROM} ${ATTEMPTS} ${where} AND a.outcome <> 'blocked'
) timed`),
  ]);

  const series = Array.from({ length: count }, (_, i) => ({
    start: new Date((from + i * size) * 1000).toISOString(),
    succeeded: 0,
    failed: 0,
    inProgress: 0,
  }));
  const failureReasons = {
    non_retryable: 0,
    exhausted: 0,
    ssrf_blocked: 0,
    destination_disabled: 0,
  };
  for (const { bucket: index, status, failureReason, n } of statuses) {
    series[index][
      status === "succeeded" || status === "failed" ? status : "inProgress"
    ] += n;
    if (failureReason) failureReasons[failureReason] += n;
  }
  const outcomes = {
    success: 0,
    http_error: 0,
    timeout: 0,
    network_error: 0,
    blocked: 0,
  };
  for (const { outcome, n } of attempts) outcomes[outcome] = n;

  const succeeded = sum(series.map((point) => point.succeeded));
  const failed = sum(series.map((point) => point.failed));
  const inProgress = sum(series.map((point) => point.inProgress));
  return {
    range,
    bucket,
    from: new Date(from * 1000).toISOString(),
    to: new Date(to * 1000).toISOString(),
    retentionDays: workspace.retentionDays,
    totals: {
      deliveries: succeeded + failed + inProgress,
      succeeded,
      failed,
      inProgress,
      successRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
      attempts: sum(Object.values(outcomes)),
      p50Ms: percentiles.p50Ms,
      p95Ms: percentiles.p95Ms,
    },
    series,
    failureReasons,
    outcomes,
    destinations: destinations.map((row) => ({
      ...row,
      deleted: Boolean(row.deleted),
      deliveries: Number(row.deliveries),
      succeeded: Number(row.succeeded),
      failed: Number(row.failed),
    })),
  };
};

module.exports = { RANGES, getDeliveryAnalytics };
