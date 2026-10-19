module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE workspaces (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id            CHAR(30) NOT NULL UNIQUE,
  owner_user_id        BIGINT UNSIGNED NOT NULL,
  status               ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  max_endpoints        SMALLINT UNSIGNED NOT NULL,
  max_destinations     SMALLINT UNSIGNED NOT NULL,
  max_events_per_day   INT UNSIGNED NOT NULL,
  max_body_bytes       INT UNSIGNED NOT NULL,
  retention_days       SMALLINT UNSIGNED NOT NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  UNIQUE KEY uq_workspaces_owner (owner_user_id)
)
`),
  down: (queryInterface) => queryInterface.dropTable("workspaces"),
};
