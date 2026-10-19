module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE endpoints (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id          CHAR(30)     NOT NULL UNIQUE,
  workspace_id       BIGINT UNSIGNED NOT NULL,
  name               VARCHAR(100) NOT NULL,
  slug               CHAR(24)     NOT NULL UNIQUE,
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  idempotency_header VARCHAR(100) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  INDEX idx_endpoints_ws (workspace_id, created_at)
)
`),
  down: (queryInterface) => queryInterface.dropTable("endpoints"),
};
