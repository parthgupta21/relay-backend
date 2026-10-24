const http = require("http");

const startReceiver = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (req.url === "/hang") return;
      const status = req.url.match(/^\/status\/(\d+)(?:\/(\d+))?$/);
      if (status) {
        res.writeHead(
          Number(status[1]),
          status[2] ? { "Retry-After": status[2] } : {},
        );
        return res.end();
      }
      if (req.url === "/big") {
        res.writeHead(200);
        return res.end("a".repeat(100 * 1024));
      }
      if (req.url === "/slow-fail")
        return setTimeout(() => {
          res.writeHead(500);
          res.end();
        }, 300);
      if (req.url === "/fail") {
        res.writeHead(500);
        return res.end("boom");
      }
      if (req.url === "/bad") {
        res.writeHead(400);
        return res.end("bad");
      }
      if (req.url === "/flaky" && requests.length === 1) {
        res.writeHead(500);
        return res.end("boom");
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/redirected" });
        return res.end();
      }
      res.writeHead(200, { "X-Receiver": "yes" });
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
};

module.exports = { startReceiver };
