const sequelize = require("../database");
const User = require("./user");
const Workspace = require("./workspace");
const Session = require("./session");
const EmailToken = require("./emailToken");
const Endpoint = require("./endpoint");
const Event = require("./event");
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

module.exports = {
  sequelize,
  User,
  Workspace,
  Session,
  EmailToken,
  Endpoint,
  Event,
  AuditLog,
};
