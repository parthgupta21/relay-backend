module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE destinations (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id      CHAR(30)      NOT NULL UNIQUE,
  endpoint_id    BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(100)  NOT NULL,
  url            VARCHAR(2048) NOT NULL,
  custom_headers JSON          NULL,
  signing_secret VARBINARY(128) NOT NULL,
  timeout_ms     INT UNSIGNED  NOT NULL DEFAULT 10000,
  max_attempts   TINYINT UNSIGNED NOT NULL DEFAULT 8,
  is_active      BOOLEAN       NOT NULL DEFAULT TRUE,
  deleted_at     DATETIME(3)   NULL,
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE,
  INDEX idx_destinations_endpoint (endpoint_id, is_active)
)
`),
  down: (queryInterface) => queryInterface.dropTable("destinations"),
};
