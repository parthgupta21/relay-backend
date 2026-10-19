const { DataTypes } = require("sequelize");
const sequelize = require("../database");
const { publicId } = require("../utils");

const DEFAULT_PLAN = {
  maxEndpoints: 5,
  maxDestinations: 3,
  maxEventsPerDay: 5000,
  maxBodyBytes: 524288,
  retentionDays: 3,
};

const Workspace = sequelize.define(
  "Workspace",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("ws"),
    },
    ownerUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    status: {
      type: DataTypes.ENUM("active", "suspended", "deleted"),
      allowNull: false,
      defaultValue: "active",
    },
    maxEndpoints: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    maxDestinations: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    maxEventsPerDay: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    maxBodyBytes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    retentionDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
  },
  {
    tableName: "workspaces",
    underscored: true,
    createdAt: "created_at",
    updatedAt: false,
  },
);

Workspace.planDefaults = () => ({
  ...DEFAULT_PLAN,
  ...JSON.parse(process.env.PLAN_DEFAULTS || "{}"),
});

Workspace.prototype.limits = function () {
  const {
    maxEndpoints,
    maxDestinations,
    maxEventsPerDay,
    maxBodyBytes,
    retentionDays,
  } = this;
  return {
    maxEndpoints,
    maxDestinations,
    maxEventsPerDay,
    maxBodyBytes,
    retentionDays,
  };
};

module.exports = Workspace;
