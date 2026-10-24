const IORedis = require("ioredis");
const { Server } = require("socket.io");
const { Session } = require("../models");
const { connection } = require("./queue");
const { isAllowedOrigin } = require("../middleware/originCheck");

const CHANNEL = process.env.NODE_ENV === "test" ? "test:realtime" : "realtime";

const publish = async (workspaceId, type, data) => {
  if (connection.status !== "ready")
    return console.warn("realtime publish skipped, redis not ready");
  await connection
    .publish(CHANNEL, JSON.stringify({ workspaceId, type, data }))
    .catch((err) => console.warn("realtime publish failed", err.message));
};

const attach = (server) => {
  const io = new Server(server, {
    allowRequest: (req, callback) =>
      callback(null, isAllowedOrigin(req.headers.origin)),
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.headers.cookie?.match(
      /(?:^|;\s*)relay_sid=([^;]+)/,
    )?.[1];
    let session;
    try {
      session = token && (await Session.findActive(token));
    } catch (err) {
      console.warn("realtime auth failed", err.message);
      return next(new Error("SERVICE_UNAVAILABLE"));
    }
    if (!session) return next(new Error("UNAUTHENTICATED"));
    socket.join(`ws:${session.user.workspace.id}`);
    next();
  });

  const subscriber = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  subscriber.on("error", (err) =>
    console.warn("realtime subscriber error", err.message),
  );
  subscriber.on("message", (_channel, message) => {
    const { workspaceId, type, data } = JSON.parse(message);
    io.to(`ws:${workspaceId}`).emit(type, data);
  });
  subscriber
    .subscribe(CHANNEL)
    .catch((err) => console.warn("realtime subscribe failed", err.message));

  return {
    close: () => {
      subscriber.disconnect();
      return io.close();
    },
  };
};

module.exports = { publish, attach };
