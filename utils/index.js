const crypto = require("crypto");
const ipaddr = require("ipaddr.js");
const { ulid } = require("ulid");

const ERROR_CODES = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  EMAIL_NOT_VERIFIED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  PAYLOAD_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 422,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

class AppError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const publicId = (prefix) => `${prefix}_${ulid()}`;

const randomToken = (bytes) => crypto.randomBytes(bytes).toString("base64url");

const sha256 = (input) => crypto.createHash("sha256").update(input).digest();

const ipToBytes = (ip) => Buffer.from(ipaddr.process(ip).toByteArray());

const bytesToIp = (bytes) => ipaddr.fromByteArray([...bytes]).toString();

module.exports = {
  ERROR_CODES,
  AppError,
  publicId,
  randomToken,
  sha256,
  ipToBytes,
  bytesToIp,
};
