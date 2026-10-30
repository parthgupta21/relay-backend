const {
  sequelize,
  Session,
  EmailToken,
  ApiToken,
  AuditLog,
} = require("../models");
const { connection } = require("./queue");
const { AppError } = require("../utils");

const PREFIX = process.env.NODE_ENV === "test" ? "test:" : "";

const unlinkMatching = async (match) => {
  for await (const keys of connection.scanStream({ match }))
    if (keys.length) await connection.unlink(...keys);
};

const deleteWorkspace = async (workspace, { actorUserId, ip, action }) => {
  await sequelize.transaction(async (transaction) => {
    await workspace.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (workspace.status === "deleted")
      throw new AppError("CONFLICT", 409, "Workspace is deleted");
    const owner = await workspace.getOwner({ transaction });
    await owner.update(
      {
        deletedAt: new Date(),
        email: `deleted-${owner.publicId}@deleted.invalid`,
        passwordHash: "!",
      },
      { transaction },
    );
    await workspace.update({ status: "deleted" }, { transaction });
    await Session.destroy({ where: { userId: owner.id }, transaction });
    await EmailToken.destroy({ where: { userId: owner.id }, transaction });
    await ApiToken.destroy({
      where: { workspaceId: workspace.id },
      transaction,
    });
    await AuditLog.record(action, {
      workspaceId: workspace.id,
      actorUserId,
      ip,
      meta: { userId: owner.publicId },
      transaction,
    });
  });
  await Promise.all([
    unlinkMatching(`${PREFIX}usage:${workspace.id}:*`),
    unlinkMatching(`${PREFIX}idem:${workspace.id}:*`),
  ]).catch((err) => console.warn("redis cleanup failed", err.message));
};

module.exports = { deleteWorkspace };
