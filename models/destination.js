const crypto = require("crypto");
const { DataTypes } = require("sequelize");
const sequelize = require("../database");
const { AppError, publicId, randomToken } = require("../utils");

const IV_BYTES = 12;
const TAG_BYTES = 16;

const key = () => {
  const bytes = Buffer.from(process.env.RELAY_ENCRYPTION_KEY || "", "base64");
  if (bytes.length !== 32)
    throw new Error("RELAY_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return bytes;
};

const Destination = sequelize.define(
  "Destination",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("dst"),
    },
    endpointId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    url: { type: DataTypes.STRING(2048), allowNull: false },
    customHeaders: { type: DataTypes.JSON, allowNull: true },
    signingSecret: { type: DataTypes.BLOB, allowNull: false },
    timeoutMs: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 10000,
    },
    maxAttempts: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 8,
    },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "destinations",
    underscored: true,
    updatedAt: false,
    paranoid: true,
  },
);

Destination.assertEncryptionKey = key;

Destination.generateSecret = () => `whsec_${randomToken(32)}`;

Destination.encryptSecret = (secret) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
};

Destination.getOwned = async (workspaceId, id) => {
  const destination = await Destination.findOne({
    where: { publicId: id },
    include: [
      {
        model: sequelize.models.Endpoint.forWorkspace(workspaceId),
        as: "endpoint",
        required: true,
      },
    ],
  });
  if (!destination)
    throw new AppError("NOT_FOUND", 404, "Destination not found");
  return destination;
};

Destination.prototype.decryptSecret = function () {
  const stored = this.signingSecret;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    stored.subarray(0, IV_BYTES),
  );
  decipher.setAuthTag(stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(stored.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
};

Destination.prototype.present = function () {
  return {
    id: this.publicId,
    name: this.name,
    url: this.url,
    customHeaders: this.customHeaders,
    timeoutMs: this.timeoutMs,
    maxAttempts: this.maxAttempts,
    isActive: this.isActive,
    createdAt: this.createdAt,
  };
};

module.exports = Destination;
