const crypto = require("crypto");
const { DataTypes } = require("sequelize");
const sequelize = require("../database");
const { publicId } = require("../utils");

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const Endpoint = sequelize.define(
  "Endpoint",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("ep"),
    },
    workspaceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    slug: { type: DataTypes.CHAR(24), allowNull: false, unique: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    idempotencyHeader: { type: DataTypes.STRING(100), allowNull: true },
  },
  {
    tableName: "endpoints",
    underscored: true,
    createdAt: "created_at",
    updatedAt: false,
    scopes: {
      forWorkspace: (workspaceId) => ({ where: { workspaceId } }),
    },
  },
);

Endpoint.forWorkspace = (workspaceId) =>
  Endpoint.scope({ method: ["forWorkspace", workspaceId] });

Endpoint.generateSlug = () => {
  let slug = "";
  while (slug.length < 24) {
    for (const byte of crypto.randomBytes(32)) {
      if (byte < 248 && slug.length < 24) slug += BASE62[byte % 62];
    }
  }
  return slug;
};

Endpoint.prototype.present = function (eventCount24h) {
  return {
    id: this.publicId,
    name: this.name,
    slug: this.slug,
    url: `${process.env.HOOKS_BASE_URL}/h/${this.slug}`,
    isActive: this.isActive,
    idempotencyHeader: this.idempotencyHeader,
    eventCount24h,
    createdAt: this.createdAt,
  };
};

module.exports = Endpoint;
