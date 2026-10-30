require("dotenv").config({ quiet: true });
const { sequelize, User, AuditLog } = require("../models");

const setOperator = async (email, value) => {
  const user = await User.findOne({
    where: { email: email.trim().toLowerCase(), deletedAt: null },
  });
  if (!user) throw new Error("User not found");
  if (value && !user.emailVerifiedAt) throw new Error("Email not verified");
  await sequelize.transaction(async (transaction) => {
    await user.update({ isOperator: value }, { transaction });
    await AuditLog.record(value ? "operator.granted" : "operator.revoked", {
      meta: { via: "cli", userId: user.publicId },
      transaction,
    });
  });
};

if (require.main === module) {
  const [command, email] = process.argv.slice(2);
  if (!["grant", "revoke"].includes(command) || !email) {
    console.error("usage: npm run operator -- grant|revoke <email>");
    process.exit(1);
  }
  setOperator(email, command === "grant")
    .then(() => console.info(`${command} ok: ${email}`))
    .catch((err) => {
      console.error(`${command} failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}

module.exports = { setOperator };
