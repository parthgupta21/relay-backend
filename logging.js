const util = require("util");
const namespace = require("./namespace");

const maskSlug = (path) => path.replace(/^(\/h\/[^/]{6})[^/]*/, "$1...");

const write =
  (level, stream) =>
  (...args) => {
    const ctx = namespace.active && namespace.get("ctx");
    const requestId = (namespace.active && namespace.get("requestId")) || "-";
    const method = ctx ? ctx.method : "-";
    const url = ctx ? maskSlug(ctx.path) : "-";
    stream(
      `level=[${level}] requestId=${requestId} method=${method} url=${url} msg="${util.format(...args)}"`,
    );
  };

const out = process.stdout.write.bind(process.stdout);
const err = process.stderr.write.bind(process.stderr);
const toOut = (line) => out(line + "\n");
const toErr = (line) => err(line + "\n");

console.log = write("INFO", toOut);
console.info = write("INFO", toOut);
console.debug = write("DEBUG", toOut);
console.warn = write("WARN", toErr);
console.error = write("ERROR", toErr);
