const { DataTypes } = require("sequelize");
const sequelize = require("../database");
const { ipToBytes } = require("../utils");

const AuditLog = sequelize.define(
  "AuditLog",
  {
    workspaceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    actorUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    action: { type: DataTypes.STRING(64), allowNull: false },
    ip: { type: DataTypes.BLOB, allowNull: true },
    meta: { type: DataTypes.JSON, allowNull: true },
  },
  {
    tableName: "audit_log",
    underscored: true,
    updatedAt: false,
  },
);

AuditLog.record = (action, { workspaceId, actorUserId, ip, meta }) =>
  AuditLog.create({
    action,
    workspaceId,
    actorUserId,
    ip: ip && ipToBytes(ip),
    meta,
  });

module.exports = AuditLog;
