module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
ALTER TABLE workspaces
  ADD COLUMN max_events_per_month INT UNSIGNED NOT NULL DEFAULT 100000 AFTER max_events_per_day
`),
  down: (queryInterface) =>
    queryInterface.removeColumn("workspaces", "max_events_per_month"),
};
