const http = require("http");
const client = require("prom-client");

const registry = new client.Registry();
client.collectDefaultMetrics({ prefix: "relay_", register: registry });

const httpRequests = new client.Counter({
  name: "relay_http_requests_total",
  help: "HTTP requests handled",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: "relay_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  registers: [registry],
});

const deliveryAttempts = new client.Counter({
  name: "relay_delivery_attempts_total",
  help: "Delivery attempts recorded",
  labelNames: ["outcome"],
  registers: [registry],
});

const deliveryAttemptDuration = new client.Histogram({
  name: "relay_delivery_attempt_duration_seconds",
  help: "Delivery attempt duration in seconds",
  registers: [registry],
});

const middleware = async (ctx, next) => {
  const end = httpDuration.startTimer();
  await next();
  const route = ctx._matchedRoute || "unmatched";
  end({ method: ctx.method, route });
  httpRequests.inc({ method: ctx.method, route, status: ctx.status });
};

const serve = (port, ready) => {
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/metrics") {
      res.writeHead(200, { "Content-Type": registry.contentType });
      return res.end(await registry.metrics());
    }
    if (pathname === "/healthz") return res.writeHead(200).end();
    if (pathname === "/readyz")
      return res.writeHead((await ready()) ? 200 : 503).end();
    res.writeHead(404).end();
  });
  return server.listen(port);
};

module.exports = {
  registry,
  middleware,
  serve,
  deliveryAttempts,
  deliveryAttemptDuration,
};
