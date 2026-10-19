module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE deliveries (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id       CHAR(30) NOT NULL UNIQUE,
  event_id        BIGINT UNSIGNED NOT NULL,
  destination_id  BIGINT UNSIGNED NOT NULL,
  \`trigger\`       ENUM('auto','manual') NOT NULL,
  replay_of_id    BIGINT UNSIGNED NULL,
  status          ENUM('pending','in_flight','retry_scheduled','succeeded','failed') NOT NULL,
  failure_reason  ENUM('non_retryable','exhausted','ssrf_blocked','destination_disabled') NULL,
  attempt_count   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  locked_until    DATETIME(3) NULL,
  last_status     SMALLINT UNSIGNED NULL,
  completed_at    DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  auto_key        TINYINT AS (IF(\`trigger\` = 'auto', 1, NULL)) STORED,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE CASCADE,
  FOREIGN KEY (replay_of_id) REFERENCES deliveries(id) ON DELETE SET NULL,
  UNIQUE KEY uq_deliveries_auto (event_id, destination_id, auto_key),
  INDEX idx_deliveries_due (status, next_attempt_at),
  INDEX idx_deliveries_dest_time (destination_id, created_at, status)
)
`),
  down: (queryInterface) => queryInterface.dropTable("deliveries"),
};
