module.exports = {
  up: (queryInterface) =>
    queryInterface.sequelize.query(`
CREATE TABLE email_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  purpose     ENUM('verify','reset') NOT NULL,
  token_hash  BINARY(32)  NOT NULL UNIQUE,
  expires_at  DATETIME(3) NOT NULL,
  used_at     DATETIME(3) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
`),
  down: (queryInterface) => queryInterface.dropTable("email_tokens"),
};
