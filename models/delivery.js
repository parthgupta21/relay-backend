const { DataTypes } = require("sequelize");
const sequelize = require("../database");
const { AppError, publicId } = require("../utils");

const Delivery = sequelize.define(
  "Delivery",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("dlv"),
    },
    eventId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    destinationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    trigger: { type: DataTypes.ENUM("auto", "manual"), allowNull: false },
    replayOfId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    status: {
      type: DataTypes.ENUM(
        "pending",
        "in_flight",
        "retry_scheduled",
        "succeeded",
        "failed",
      ),
      allowNull: false,
    },
    failureReason: {
      type: DataTypes.ENUM(
        "non_retryable",
        "exhausted",
        "ssrf_blocked",
        "destination_disabled",
      ),
      allowNull: true,
    },
    attemptCount: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    nextAttemptAt: { type: DataTypes.DATE(3), allowNull: true },
    lockedUntil: { type: DataTypes.DATE(3), allowNull: true },
    lastStatus: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    completedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  { tableName: "deliveries", underscored: true },
);

Delivery.getOwned = async (workspaceId, id) => {
  const { Event, Endpoint, Destination, DeliveryAttempt } = sequelize.models;
  const delivery = await Delivery.findOne({
    where: { publicId: id },
    include: [
      {
        model: Event,
        as: "event",
        required: true,
        include: [
          {
            model: Endpoint.forWorkspace(workspaceId),
            as: "endpoint",
            required: true,
          },
        ],
      },
      { model: Destination, as: "destination", paranoid: false },
      { model: Delivery, as: "replayOf" },
      { model: DeliveryAttempt, as: "attempts" },
    ],
    order: [[{ model: DeliveryAttempt, as: "attempts" }, "attemptNo", "ASC"]],
  });
  if (!delivery) throw new AppError("NOT_FOUND", 404, "Delivery not found");
  return delivery;
};

Delivery.prototype.present = function () {
  return {
    id: this.publicId,
    destinationId: this.destination.publicId,
    destinationName: this.destination.name,
    trigger: this.trigger,
    replayOf: this.replayOf?.publicId ?? null,
    status: this.status,
    failureReason: this.failureReason,
    attemptCount: this.attemptCount,
    lastStatus: this.lastStatus,
    nextAttemptAt: this.nextAttemptAt,
    completedAt: this.completedAt,
    createdAt: this.createdAt,
  };
};

module.exports = Delivery;
