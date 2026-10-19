module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE delivery_attempts (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  delivery_id      BIGINT UNSIGNED NOT NULL,
  attempt_no       TINYINT UNSIGNED NOT NULL,
  started_at       DATETIME(3) NOT NULL,
  duration_ms      INT UNSIGNED NOT NULL,
  outcome          ENUM('success','http_error','timeout','network_error','blocked') NOT NULL,
  response_status  SMALLINT UNSIGNED NULL,
  response_headers JSON NULL,
  response_body    BLOB NULL,
  error_message    VARCHAR(1024) NULL,
  FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  UNIQUE KEY uq_attempts (delivery_id, attempt_no)
)
`),
  down: (queryInterface) => queryInterface.dropTable("delivery_attempts"),
};
