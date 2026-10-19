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
      if (req.url === "/fail") {
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
