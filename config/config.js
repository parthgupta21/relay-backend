require("dotenv").config({ quiet: true });

const base = {
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  dialect: "mysql",
  timezone: "+00:00",
  logging: false,
  pool: { max: Number(process.env.DB_POOL_MAX) || 10 },
};

module.exports = {
  development: { ...base, database: process.env.DB_NAME },
  test: { ...base, database: process.env.DB_NAME_TEST },
  production: { ...base, database: process.env.DB_NAME },
};
