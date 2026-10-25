const crypto = require("crypto");
const ipaddr = require("ipaddr.js");
const { ulid } = require("ulid");

class AppError extends Error {
  constructor(code, status, message, details, retryAfter) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

const publicId = (prefix) => `${prefix}_${ulid()}`;

const randomToken = (bytes) => crypto.randomBytes(bytes).toString("base64url");

const sha256 = (input) => crypto.createHash("sha256").update(input).digest();

const ipToBytes = (ip) => Buffer.from(ipaddr.process(ip).toByteArray());

const bytesToIp = (bytes) => ipaddr.fromByteArray([...bytes]).toString();

module.exports = {
  AppError,
  publicId,
  randomToken,
  sha256,
  ipToBytes,
  bytesToIp,
};
