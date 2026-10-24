const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const IORedis = require("ioredis");
const { Worker } = require("bullmq");
const { io: connect } = require("socket.io-client");
const { app, request, sequelize, resetDatabase, signUp } = require("./helpers");
const { startReceiver } = require("./receiver");
const { attach } = require("../services/realtime");
const { processJob } = require("../services/delivery");
const queue = require("../services/queue");

let server;
let realtime;
let receiver;
let worker;
let workerConnection;
let agent;
let endpoint;
let socket;
let otherSocket;

const cookieHeader = (user) => ({
  Cookie: user.jar
    .getCookie("relay_sid", {
      domain: "127.0.0.1",
      path: "/",
      secure: false,
      script: false,
    })
    .toValueString(),
});

const openSocket = (user) =>
  connect(`http://127.0.0.1:${server.address().port}`, {
    extraHeaders: cookieHeader(user),
  });

const nextMessage = (target, type) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type}`)), 5000);
    target.once(type, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

const ingest = () =>
  request(app.callback()).post(`/h/${endpoint.slug}`).send({ hello: "world" });

before(async () => {
  await resetDatabase();
  server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  realtime = attach(server);
  agent = await signUp("live@example.com");
  endpoint = (await agent.post("/api/v1/endpoints").send({ name: "live" }))
    .body;
  const other = await signUp("other@example.com");
  socket = openSocket(agent);
  otherSocket = openSocket(other);
  await Promise.all([
    nextMessage(socket, "connect"),
    nextMessage(otherSocket, "connect"),
  ]);
  receiver = await startReceiver();
  workerConnection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  worker = new Worker(queue.QUEUE_NAME, processJob, {
    connection: workerConnection,
  });
  await worker.waitUntilReady();
});

after(async () => {
  socket.close();
  otherSocket.close();
  await realtime.close();
  await worker.close();
  workerConnection.disconnect();
  await receiver.close();
  await sequelize.close();
});

test("a socket without a session cookie is rejected", async () => {
  const anonymous = connect(`http://127.0.0.1:${server.address().port}`);
  const err = await nextMessage(anonymous, "connect_error");
  anonymous.close();
  assert.strictEqual(err.message, "UNAUTHENTICATED");
});

test("a socket from a foreign origin is rejected", async () => {
  const foreign = connect(`http://127.0.0.1:${server.address().port}`, {
    extraHeaders: { ...cookieHeader(agent), Origin: "http://evil.example" },
    reconnection: false,
  });
  const err = await nextMessage(foreign, "connect_error");
  foreign.close();
  assert.notStrictEqual(err.message, "UNAUTHENTICATED");
});

test("event.created reaches only the owning workspace, with public ids", async () => {
  const leaked = [];
  otherSocket.on("event.created", (message) => leaked.push(message));
  const received = nextMessage(socket, "event.created");

  const res = await ingest();

  assert.deepStrictEqual(await received, {
    endpointId: endpoint.id,
    eventId: res.body.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(leaked, []);
});

test(
  "delivery.updated reports in_flight then succeeded",
  { timeout: 10000 },
  async () => {
    await agent
      .post(`/api/v1/endpoints/${endpoint.id}/destinations`)
      .send({ name: "ok", url: `${receiver.url}/ok` });
    const statuses = [];
    const succeeded = new Promise((resolve) =>
      socket.on("delivery.updated", (message) => {
        statuses.push(message.status);
        if (message.status === "succeeded") resolve(message);
      }),
    );

    const res = await ingest();

    const message = await succeeded;
    assert.deepStrictEqual(statuses, ["in_flight", "succeeded"]);
    assert.strictEqual(message.eventId, res.body.id);
    assert.match(message.deliveryId, /^dlv_/);
  },
);
