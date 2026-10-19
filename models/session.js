const { DataTypes, Op } = require("sequelize");
const sequelize = require("../database");
const { randomToken, sha256 } = require("../utils");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const Session = sequelize.define(
  "Session",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    tokenHash: { type: DataTypes.BLOB, allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  {
    tableName: "sessions",
    underscored: true,
    updatedAt: false,
  },
);

Session.TTL_MS = SESSION_TTL_MS;

Session.start = async (userId) => {
  const token = randomToken(32);
  await Session.create({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
};

Session.findActive = (token) =>
  Session.findOne({
    where: { tokenHash: sha256(token), expiresAt: { [Op.gt]: new Date() } },
    include: [
      {
        association: "user",
        where: { deletedAt: null },
        required: true,
        include: [{ association: "workspace" }],
      },
    ],
  });

module.exports = Session;
