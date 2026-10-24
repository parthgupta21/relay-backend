const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const modulePath = require.resolve("../services/ssrf");
const { checkUrl, SsrfError } = require("../services/ssrf");

beforeEach(() => {
  process.env.SSRF_ALLOWLIST = "";
});

const BLOCKED = [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "[::1]",
  "[fc00::]",
  "[fe80::1]",
  "[::ffff:127.0.0.1]",
  "[::ffff:169.254.169.254]",
  "[::5]",
];

for (const host of BLOCKED)
  test(`blocks ${host}`, async () => {
    await assert.rejects(checkUrl(`http://${host}/hook`), SsrfError);
  });

test("rejects bad scheme, userinfo and port 22", async () => {
  for (const url of [
    "ftp://93.184.216.34/",
    "http://user:pass@93.184.216.34/",
    "http://93.184.216.34:22/",
    "not a url",
  ])
    await assert.rejects(checkUrl(url), SsrfError, url);
});

test("allows a public IP and the permitted ports", async () => {
  for (const url of [
    "http://93.184.216.34/",
    "https://93.184.216.34:443/x",
    "http://93.184.216.34:8080/",
    "http://93.184.216.34:443/",
  ]) {
    const { address } = await checkUrl(url);
    assert.strictEqual(address.address, "93.184.216.34");
  }
});

test("unresolvable host is rejected", async () => {
  await assert.rejects(checkUrl("http://nonexistent.invalid/"), SsrfError);
});

test("allowlist lets listed ranges through only", async () => {
  process.env.SSRF_ALLOWLIST = "127.0.0.1/32";
  assert.strictEqual(
    (await checkUrl("http://127.0.0.1:8080/")).address.address,
    "127.0.0.1",
  );
  await assert.rejects(checkUrl("http://127.0.0.2/"), SsrfError);
  await assert.rejects(checkUrl("http://10.0.0.1/"), SsrfError);
});

test("allowlist in production throws at load", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  process.env.SSRF_ALLOWLIST = "127.0.0.1/32";
  delete require.cache[modulePath];
  try {
    assert.throws(() => require("../services/ssrf"), /SSRF_ALLOWLIST/);
  } finally {
    process.env.NODE_ENV = previous;
    delete require.cache[modulePath];
  }
});

test("a RELAY ingest hostname is rejected, with or without a trailing dot", async () => {
  const previous = process.env.HOOKS_BASE_URL;
  process.env.HOOKS_BASE_URL = "http://hooks.test:3000";
  try {
    for (const url of ["http://hooks.test/x", "http://hooks.test./x"])
      await assert.rejects(checkUrl(url), /ingest URL/, url);
  } finally {
    if (previous === undefined) delete process.env.HOOKS_BASE_URL;
    else process.env.HOOKS_BASE_URL = previous;
  }
});

test("checkUrl works when HOOKS_BASE_URL is unset", async () => {
  const previous = process.env.HOOKS_BASE_URL;
  delete process.env.HOOKS_BASE_URL;
  try {
    const { address } = await checkUrl("http://93.184.216.34/");
    assert.strictEqual(address.address, "93.184.216.34");
  } finally {
    if (previous !== undefined) process.env.HOOKS_BASE_URL = previous;
  }
});
