const { Op } = require("sequelize");
const {
  Workspace,
  Endpoint,
  Event,
  Session,
  EmailToken,
} = require("../models");

const BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const purgeExpired = async () => {
  let purged = 0;
  for (const workspace of await Workspace.findAll()) {
    const endpoints = await Endpoint.findAll({
      where: { workspaceId: workspace.id },
      attributes: ["id"],
    });
    const deleted = workspace.status === "deleted";
    const where = {
      endpointId: endpoints.map(({ id }) => id),
      ...(!deleted && {
        receivedAt: {
          [Op.lt]: new Date(Date.now() - workspace.retentionDays * DAY_MS),
        },
      }),
    };
    let destroyed;
    do {
      destroyed = await Event.destroy({ where, limit: BATCH });
      purged += destroyed;
    } while (destroyed === BATCH);
    if (deleted)
      await Endpoint.destroy({ where: { workspaceId: workspace.id } });
  }
  const now = new Date();
  await Session.destroy({ where: { expiresAt: { [Op.lt]: now } } });
  await EmailToken.destroy({
    where: {
      [Op.or]: [{ expiresAt: { [Op.lt]: now } }, { usedAt: { [Op.ne]: null } }],
    },
  });
  return purged;
};

module.exports = { purgeExpired };
