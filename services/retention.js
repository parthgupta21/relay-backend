const { Op } = require("sequelize");
const { Workspace, Endpoint, Event } = require("../models");

const BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const purgeExpired = async () => {
  let purged = 0;
  for (const workspace of await Workspace.findAll()) {
    const endpoints = await Endpoint.findAll({
      where: { workspaceId: workspace.id },
      attributes: ["id"],
    });
    const where = {
      endpointId: endpoints.map(({ id }) => id),
      receivedAt: {
        [Op.lt]: new Date(Date.now() - workspace.retentionDays * DAY_MS),
      },
    };
    for (;;) {
      const events = await Event.findAll({
        where,
        attributes: ["id"],
        limit: BATCH,
      });
      if (!events.length) break;
      purged += await Event.destroy({
        where: { id: events.map(({ id }) => id) },
      });
    }
  }
  return purged;
};

module.exports = { purgeExpired };
