const argon2 = require("argon2");
const { DataTypes, UniqueConstraintError } = require("sequelize");
const sequelize = require("../database");
const { publicId } = require("../utils");

const dummyHash = argon2.hash("not-a-real-password");

const User = sequelize.define(
  "User",
  {
    publicId: {
      type: DataTypes.CHAR(30),
      allowNull: false,
      unique: true,
      defaultValue: () => publicId("usr"),
    },
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    emailVerifiedAt: { type: DataTypes.DATE(3), allowNull: true },
    isOperator: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    deletedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  {
    tableName: "users",
    underscored: true,
    createdAt: "created_at",
    updatedAt: false,
  },
);

User.register = async (email, password) => {
  const passwordHash = await argon2.hash(password);
  const { Workspace, EmailToken } = sequelize.models;
  try {
    return await sequelize.transaction(async (transaction) => {
      const user = await User.create({ email, passwordHash }, { transaction });
      await Workspace.create(
        { ownerUserId: user.id, ...Workspace.planDefaults() },
        { transaction },
      );
      const token = await EmailToken.issue(user.id, "verify", transaction);
      return { user, token };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return null;
    throw err;
  }
};

User.authenticate = async (email, password) => {
  const user = await User.findOne({ where: { email, deletedAt: null } });
  const ok = await argon2.verify(
    user ? user.passwordHash : await dummyHash,
    password,
  );
  return user && ok ? user : null;
};

User.prototype.setPassword = async function (password, transaction) {
  return this.update(
    { passwordHash: await argon2.hash(password) },
    { transaction },
  );
};

module.exports = User;
