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
    { ...fields, lockedUntil: null, completedAt: new Date() },
    { transaction },
  );

const recordAttempt = (delivery, result) =>
  sequelize.transaction(async (transaction) => {
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
    await settle(
      delivery,
      result.outcome === "success"
        ? { status: "succeeded", lastStatus: result.responseStatus }
        : {
            status: "failed",
            failureReason:
              result.outcome === "blocked" ? "ssrf_blocked" : "non_retryable",
            lastStatus: result.responseStatus,
          },
      transaction,
    );
  });

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
