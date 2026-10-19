module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE audit_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  workspace_id  BIGINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  action        VARCHAR(64) NOT NULL,
  ip            VARBINARY(16) NULL,
  meta          JSON NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_ws (workspace_id, created_at)
)
`),
  down: (queryInterface) => queryInterface.dropTable("audit_log"),
};
