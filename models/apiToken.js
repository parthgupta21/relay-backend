const { DataTypes, Op } = require("sequelize");
const sequelize = require("../database");
const { AppError, publicId, randomToken, sha256 } = require("../utils");

const ApiToken = sequelize.define(
  "ApiToken",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("tok"),
    },
    workspaceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    prefix: { type: DataTypes.CHAR(12), allowNull: false },
    tokenHash: { type: DataTypes.BLOB, allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: true },
    lastUsedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  {
    tableName: "api_tokens",
    underscored: true,
    updatedAt: false,
  },
);

ApiToken.MAX_PER_WORKSPACE = 20;

ApiToken.issue = async (workspaceId, { name, expiresInDays }) => {
  const token = `rly_${randomToken(32)}`;
  const apiToken = await ApiToken.create({
    workspaceId,
    name,
    prefix: token.slice(0, 12),
    tokenHash: sha256(token),
    lastUsedAt: null,
    expiresAt: expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null,
  });
  return { apiToken, token };
};

ApiToken.findActive = (token) =>
  ApiToken.findOne({
    where: {
      tokenHash: sha256(token),
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    },
    include: [
      {
        association: "workspace",
        required: true,
        include: [
          {
            association: "owner",
            where: { deletedAt: null },
            required: true,
          },
        ],
      },
    ],
  });

ApiToken.getOwned = async (workspaceId, id) => {
  const apiToken = await ApiToken.findOne({
    where: { workspaceId, publicId: id },
  });
  if (!apiToken) throw new AppError("NOT_FOUND", 404, "API token not found");
  return apiToken;
};

ApiToken.prototype.present = function () {
  return {
    id: this.publicId,
    name: this.name,
    prefix: this.prefix,
    expiresAt: this.expiresAt,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
  };
};

module.exports = ApiToken;
