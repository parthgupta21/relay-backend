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
    const msg = util.format(...args).replace(/\s*[\r\n]+\s*/g, " ");
    stream.write(
      `level=[${level}] requestId=${requestId} method=${method} url=${url} msg="${msg}"\n`,
    );
  };

console.log = write("INFO", process.stdout);
console.info = write("INFO", process.stdout);
console.debug = write("DEBUG", process.stdout);
console.warn = write("WARN", process.stderr);
console.error = write("ERROR", process.stderr);
