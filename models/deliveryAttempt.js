const { DataTypes } = require("sequelize");
const sequelize = require("../database");

const DeliveryAttempt = sequelize.define(
  "DeliveryAttempt",
  {
    deliveryId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    attemptNo: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    startedAt: { type: DataTypes.DATE(3), allowNull: false },
    durationMs: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    outcome: {
      type: DataTypes.ENUM(
        "success",
        "http_error",
        "timeout",
        "network_error",
        "blocked",
      ),
      allowNull: false,
    },
    responseStatus: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    responseHeaders: { type: DataTypes.JSON, allowNull: true },
    responseBody: { type: DataTypes.BLOB, allowNull: true },
    errorMessage: { type: DataTypes.STRING(1024), allowNull: true },
  },
  { tableName: "delivery_attempts", underscored: true, timestamps: false },
);

DeliveryAttempt.prototype.present = function () {
  return {
    attemptNo: this.attemptNo,
    startedAt: this.startedAt,
    durationMs: this.durationMs,
    outcome: this.outcome,
    responseStatus: this.responseStatus,
    responseHeaders: this.responseHeaders,
    responseBody: this.responseBody ? this.responseBody.toString("utf8") : null,
    errorMessage: this.errorMessage,
  };
};

module.exports = DeliveryAttempt;
