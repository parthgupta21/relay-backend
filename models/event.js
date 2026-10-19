const { DataTypes } = require("sequelize");
const sequelize = require("../database");
const { AppError, publicId } = require("../utils");

const Event = sequelize.define(
  "Event",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("evt"),
    },
    endpointId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    method: { type: DataTypes.STRING(10), allowNull: false },
    path: { type: DataTypes.STRING(2048), allowNull: false },
    queryString: { type: DataTypes.TEXT, allowNull: true },
    headers: { type: DataTypes.JSON, allowNull: false },
    contentType: { type: DataTypes.STRING(255), allowNull: true },
    body: { type: DataTypes.BLOB("medium"), allowNull: true },
    bodyJson: { type: DataTypes.JSON, allowNull: true },
    bodySize: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    sourceIp: { type: DataTypes.BLOB, allowNull: false },
    idempotencyKey: { type: DataTypes.STRING(255), allowNull: true },
    receivedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  {
    tableName: "events",
    underscored: true,
    timestamps: false,
  },
);

Event.getOwned = async (workspaceId, id) => {
  const event = await Event.findOne({
    where: { publicId: id },
    include: [
      {
        model: sequelize.models.Endpoint.forWorkspace(workspaceId),
        as: "endpoint",
        required: true,
      },
    ],
  });
  if (!event) throw new AppError("NOT_FOUND", 404, "Event not found");
  return event;
};

module.exports = Event;
