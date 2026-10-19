const { connection } = require("./queue");

const SLOT_MS = 60000;
const PREFIX = process.env.NODE_ENV === "test" ? "test:" : "";

connection.defineCommand("acquireSlot", {
  numberOfKeys: 2,
  lua: `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) and redis.call('ZCARD', KEYS[2]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
  return 1
end
return 0
`,
});

const keys = ({ destinationId, workspaceId }) => [
  `${PREFIX}sem:dst:${destinationId}`,
  `${PREFIX}sem:ws:${workspaceId}`,
];

const acquire = async (scope, jobId) => {
  const now = Date.now();
  return (
    (await connection.acquireSlot(
      ...keys(scope),
      now,
      Number(process.env.DESTINATION_CONCURRENCY) || 5,
      Number(process.env.WORKSPACE_CONCURRENCY) || 20,
      now + SLOT_MS,
      jobId,
    )) === 1
  );
};

const release = async (scope, jobId) => {
  const [dst, ws] = keys(scope);
  await connection.multi().zrem(dst, jobId).zrem(ws, jobId).exec();
};

module.exports = { acquire, release };
