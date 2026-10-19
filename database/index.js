const { Sequelize } = require("sequelize");
const config = require("../config/config");

const { database, username, password, ...options } =
  config[process.env.NODE_ENV || "development"];

module.exports = new Sequelize(database, username, password, options);
