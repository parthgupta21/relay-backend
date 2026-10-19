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
const { retryDelay, parseRetryAfter } = require("../utils/backoff");

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

const settle = (delivery, fields, transaction) =>
  delivery.update(
    {
      lockedUntil: null,
      completedAt: fields.status === "retry_scheduled" ? null : new Date(),
      ...fields,
    },
    { transaction },
  );

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

const recordAttempt = async (delivery, result) => {
  await sequelize.transaction(async (transaction) => {
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
    await settle(delivery, nextState(delivery, result), transaction);
  });
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
  if (
    destination.deletedAt ||
    !destination.isActive ||
    destination.endpoint.workspace.status !== "active"
  )
    return settle(delivery, {
      status: "failed",
      failureReason: "destination_disabled",
    });

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

module.exports = { processDelivery };
