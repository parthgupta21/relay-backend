const sequelize = require("../database");
const User = require("./user");
const Workspace = require("./workspace");
const Session = require("./session");
const EmailToken = require("./emailToken");
const Endpoint = require("./endpoint");
const Event = require("./event");
const Destination = require("./destination");
const Delivery = require("./delivery");
const DeliveryAttempt = require("./deliveryAttempt");
const AuditLog = require("./auditLog");

User.hasOne(Workspace, { as: "workspace", foreignKey: "ownerUserId" });
Workspace.belongsTo(User, { as: "owner", foreignKey: "ownerUserId" });
User.hasMany(Session, { as: "sessions", foreignKey: "userId" });
Session.belongsTo(User, { as: "user", foreignKey: "userId" });
EmailToken.belongsTo(User, { as: "user", foreignKey: "userId" });
Workspace.hasMany(Endpoint, { as: "endpoints", foreignKey: "workspaceId" });
Endpoint.belongsTo(Workspace, { as: "workspace", foreignKey: "workspaceId" });
Endpoint.hasMany(Event, { as: "events", foreignKey: "endpointId" });
Event.belongsTo(Endpoint, { as: "endpoint", foreignKey: "endpointId" });
Endpoint.hasMany(Destination, { as: "destinations", foreignKey: "endpointId" });
Destination.belongsTo(Endpoint, { as: "endpoint", foreignKey: "endpointId" });
Event.hasMany(Delivery, { as: "deliveries", foreignKey: "eventId" });
Delivery.belongsTo(Event, { as: "event", foreignKey: "eventId" });
Destination.hasMany(Delivery, {
  as: "deliveries",
  foreignKey: "destinationId",
});
Delivery.belongsTo(Destination, {
  as: "destination",
  foreignKey: "destinationId",
});
Delivery.belongsTo(Delivery, { as: "replayOf", foreignKey: "replayOfId" });
Delivery.hasMany(DeliveryAttempt, { as: "attempts", foreignKey: "deliveryId" });
DeliveryAttempt.belongsTo(Delivery, {
  as: "delivery",
  foreignKey: "deliveryId",
});

module.exports = {
  sequelize,
  User,
  Workspace,
  Session,
  EmailToken,
  Endpoint,
  Event,
  Destination,
  Delivery,
  DeliveryAttempt,
  AuditLog,
};
