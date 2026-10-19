const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { pinnedLookup } = require("./ssrf");

const CONNECT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DROPPED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
  "cookie",
]);

const forwardedHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !DROPPED_HEADERS.has(name) && !name.startsWith("proxy-"),
    ),
  );

const sign = (secret, timestamp, body) =>
  crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");

const send = ({ delivery, event, destination, secret, address, url }) =>
  new Promise((resolve) => {
    const startedAt = new Date();
    const body = event.body || Buffer.alloc(0);
    const timestamp = Math.floor(startedAt.getTime() / 1000);
    const headers = {
      ...forwardedHeaders(event.headers),
      ...destination.customHeaders,
      "X-Relay-Event-Id": event.publicId,
      "X-Relay-Delivery-Id": delivery.publicId,
      "X-Relay-Attempt": String(delivery.attemptCount),
      "X-Relay-Timestamp": String(timestamp),
      "X-Relay-Signature": `t=${timestamp},v1=${sign(secret, timestamp, body)}`,
    };
    let req;
    let connectTimer;
    let totalTimer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      req?.destroy();
      resolve({ startedAt, durationMs: Date.now() - startedAt, ...result });
    };
    const timeout = (message) => () =>
      finish({ outcome: "timeout", errorMessage: message });

    try {
      req = (url.protocol === "https:" ? https : http).request(url, {
        method: event.method,
        headers,
        lookup: pinnedLookup(address),
        agent: false,
      });
    } catch (err) {
      return finish({ outcome: "network_error", errorMessage: err.message });
    }
    connectTimer = setTimeout(timeout("Connect timeout"), CONNECT_TIMEOUT_MS);
    totalTimer = setTimeout(timeout("Total timeout"), destination.timeoutMs);
    req.on("socket", (socket) =>
      socket.once("connect", () => clearTimeout(connectTimer)),
    );
    req.on("error", (err) =>
      finish({
        outcome: "network_error",
        errorMessage: err.message,
      }),
    );
    req.on("response", (res) => {
      const chunks = [];
      let size = 0;
      const done = () =>
        finish({
          outcome:
            res.statusCode >= 200 && res.statusCode < 300
              ? "success"
              : "http_error",
          responseStatus: res.statusCode,
          responseHeaders: res.headers,
          responseBody: Buffer.concat(chunks),
        });
      res.on("data", (chunk) => {
        if (settled) return;
        chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
        size += chunk.length;
        if (size >= MAX_RESPONSE_BYTES) done();
      });
      res.on("end", done);
      res.on("error", (err) =>
        finish({ outcome: "network_error", errorMessage: err.message }),
      );
    });
    req.end(body);
  });

module.exports = { send };
