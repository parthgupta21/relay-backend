module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE api_tokens (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id    CHAR(30)     NOT NULL UNIQUE,
  workspace_id BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(100) NOT NULL,
  prefix       CHAR(12)     NOT NULL,
  token_hash   BINARY(32)   NOT NULL UNIQUE,
  expires_at   DATETIME(3)  NULL,
  last_used_at DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  INDEX idx_api_tokens_ws (workspace_id, created_at)
)
`),
  down: (queryInterface) => queryInterface.dropTable("api_tokens"),
};
