const { QueryTypes } = require("sequelize");
const { DelayedError } = require("bullmq");
const {
  sequelize,
  Delivery,
  DeliveryAttempt,
  Destination,
  Endpoint,
  Event,
  Workspace,
} = require("../models");
const { checkUrl, SsrfError } = require("./ssrf");
const { send } = require("./outbound");
const { enqueueDeliveries } = require("./queue");
const { publish } = require("./realtime");
const { recordUsage } = require("./usage");
const { acquire, release } = require("./semaphore");
const { retryDelay, parseRetryAfter } = require("../utils/backoff");
const { deliveryAttempts, deliveryAttemptDuration } = require("./metrics");

const LOCK_SECONDS = 60;

const claim = async (deliveryId) => {
  const [claimed] = await Delivery.update(
    {
      status: "in_flight",
      lockedUntil: sequelize.literal(
        `NOW(3) + INTERVAL ${LOCK_SECONDS} SECOND`,
      ),
      attemptCount: sequelize.literal("attempt_count + 1"),
    },
    { where: { id: deliveryId, status: ["pending", "retry_scheduled"] } },
  );
  return claimed === 1;
};

const settle = async (delivery, fields, transaction) => {
  const values = {
    lockedUntil: null,
    completedAt: fields.status === "retry_scheduled" ? null : new Date(),
    ...fields,
  };
  const [settled] = await Delivery.update(values, {
    where: {
      id: delivery.id,
      status: "in_flight",
      attemptCount: delivery.attemptCount,
    },
    transaction,
  });
  if (settled) delivery.set(values);
  return settled === 1;
};

const isRetryable = ({ outcome, responseStatus }) =>
  outcome === "timeout" ||
  outcome === "network_error" ||
  (outcome === "http_error" &&
    (responseStatus === 408 ||
      responseStatus === 429 ||
      responseStatus >= 500));

const nextState = (delivery, result) => {
  const { outcome, responseStatus: lastStatus } = result;
  if (outcome === "success") return { status: "succeeded", lastStatus };
  if (outcome === "blocked")
    return { status: "failed", failureReason: "ssrf_blocked", lastStatus };
  if (!isRetryable(result))
    return { status: "failed", failureReason: "non_retryable", lastStatus };
  if (delivery.attemptCount >= delivery.destination.maxAttempts)
    return { status: "failed", failureReason: "exhausted", lastStatus };
  const retryAfter = [429, 503].includes(lastStatus)
    ? parseRetryAfter(result.responseHeaders["retry-after"])
    : 0;
  return {
    status: "retry_scheduled",
    lastStatus,
    nextAttemptAt: new Date(
      Date.now() + retryDelay(delivery.attemptCount + 1, retryAfter),
    ),
  };
};

const publishUpdate = ({ publicId, status, event, destination }) =>
  publish(destination.endpoint.workspace.id, "delivery.updated", {
    deliveryId: publicId,
    eventId: event.publicId,
    status,
  });

const recordAttempt = async (delivery, result) => {
  const settled = await sequelize.transaction(async (transaction) => {
    await DeliveryAttempt.create(
      {
        deliveryId: delivery.id,
        attemptNo: delivery.attemptCount,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        outcome: result.outcome,
        responseStatus: result.responseStatus,
        responseHeaders: result.responseHeaders,
        responseBody: result.responseBody,
        errorMessage: result.errorMessage?.slice(0, 1024),
      },
      { transaction },
    );
    return settle(delivery, nextState(delivery, result), transaction);
  });
  deliveryAttempts.inc({ outcome: result.outcome });
  deliveryAttemptDuration.observe(result.durationMs / 1000);
  if (!settled) return;
  await recordUsage(delivery.destination.endpoint.workspace.id, "deliveries");
  await publishUpdate(delivery);
  if (delivery.status === "retry_scheduled")
    await enqueueDeliveries([delivery]);
};

const processDelivery = async (deliveryId) => {
  if (!(await claim(deliveryId))) return;
  const delivery = await Delivery.findByPk(deliveryId, {
    include: [
      { model: Event, as: "event" },
      {
        model: Destination,
        as: "destination",
        paranoid: false,
        include: [
          {
            model: Endpoint,
            as: "endpoint",
            include: [{ model: Workspace, as: "workspace" }],
          },
        ],
      },
    ],
  });
  const { event, destination } = delivery;
  await publishUpdate(delivery);
  if (
    destination.deletedAt ||
    !destination.isActive ||
    destination.endpoint.workspace.status !== "active"
  ) {
    const settled = await settle(delivery, {
      status: "failed",
      failureReason: "destination_disabled",
    });
    return settled && publishUpdate(delivery);
  }

  let checked;
  try {
    checked = await checkUrl(destination.url);
  } catch (err) {
    if (!(err instanceof SsrfError)) throw err;
    return recordAttempt(delivery, {
      startedAt: new Date(),
      durationMs: 0,
      outcome: "blocked",
      errorMessage: err.message,
    });
  }
  const result = await send({
    delivery,
    event,
    destination,
    secret: destination.decryptSecret(),
    address: checked.address,
    url: checked.url,
  });
  return recordAttempt(delivery, result);
};

const deliveryScope = async (deliveryId) =>
  (
    await sequelize.query(
      `SELECT d.destination_id AS destinationId, e.workspace_id AS workspaceId
FROM deliveries d
JOIN destinations ds ON ds.id = d.destination_id
JOIN endpoints e ON e.id = ds.endpoint_id
WHERE d.id = ?`,
      { replacements: [deliveryId], type: QueryTypes.SELECT },
    )
  )[0];

const processJob = async (job, token) => {
  const { deliveryId } = job.data;
  const scope = await deliveryScope(deliveryId);
  if (!scope) return;
  if (!(await acquire(scope, job.id))) {
    await job.moveToDelayed(Date.now() + 2000 + Math.random() * 3000, token);
    throw new DelayedError();
  }
  try {
    await processDelivery(deliveryId);
  } finally {
    await release(scope, job.id);
  }
};

module.exports = { processDelivery, processJob };
