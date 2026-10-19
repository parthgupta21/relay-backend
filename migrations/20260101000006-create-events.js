module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE events (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id       CHAR(30)      NOT NULL UNIQUE,
  endpoint_id     BIGINT UNSIGNED NOT NULL,
  method          VARCHAR(10)   NOT NULL,
  path            VARCHAR(2048) NOT NULL,
  query_string    TEXT          NULL,
  headers         JSON          NOT NULL,
  content_type    VARCHAR(255)  NULL,
  body            MEDIUMBLOB    NULL,
  body_json       JSON          NULL,
  body_size       INT UNSIGNED  NOT NULL,
  source_ip       VARBINARY(16) NOT NULL,
  idempotency_key VARCHAR(255)  NULL,
  received_at     DATETIME(3)   NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE,
  UNIQUE KEY uq_events_idem (endpoint_id, idempotency_key),
  INDEX idx_events_list (endpoint_id, received_at, id),
  INDEX idx_events_retention (received_at)
)
`),
  down: (queryInterface) => queryInterface.dropTable("events"),
};
