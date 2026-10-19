const { DataTypes, Op } = require("sequelize");
const sequelize = require("../database");
const { randomToken, sha256 } = require("../utils");

const EmailToken = sequelize.define(
  "EmailToken",
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    purpose: { type: DataTypes.ENUM("verify", "reset"), allowNull: false },
    tokenHash: { type: DataTypes.BLOB, allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    usedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  {
    tableName: "email_tokens",
    underscored: true,
    timestamps: false,
  },
);

EmailToken.issue = async (userId, purpose, ttlMs, transaction) => {
  const token = randomToken(32);
  await EmailToken.create(
    {
      userId,
      purpose,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlMs),
    },
    { transaction },
  );
  return token;
};

EmailToken.consume = async (token, purpose, transaction) => {
  const row = await EmailToken.findOne({
    where: {
      tokenHash: sha256(token),
      purpose,
      usedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!row) return null;
  await row.update({ usedAt: new Date() }, { transaction });
  return row.userId;
};

module.exports = EmailToken;
