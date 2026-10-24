const dns = require("dns").promises;
const ipaddr = require("ipaddr.js");

if (process.env.NODE_ENV === "production" && process.env.SSRF_ALLOWLIST)
  throw new Error("SSRF_ALLOWLIST must not be set in production");

class SsrfError extends Error {}

const IPV4_COMPATIBLE = ipaddr.parseCIDR("::/96");

const allowlist = () =>
  (process.env.SSRF_ALLOWLIST || "")
    .split(",")
    .map((cidr) => cidr.trim())
    .filter(Boolean)
    .map((cidr) => ipaddr.parseCIDR(cidr));

const isBlocked = (address) => {
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6" && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
  if (
    allowlist().some(
      ([net, bits]) => ip.kind() === net.kind() && ip.match(net, bits),
    )
  )
    return false;
  return (
    ip.range() !== "unicast" ||
    (ip.kind() === "ipv6" && ip.match(IPV4_COMPATIBLE))
  );
};

const bareHost = (hostname) => hostname.replace(/\.$/, "");

const checkUrl = async (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new SsrfError("Only http and https are allowed");
  if (url.username || url.password)
    throw new SsrfError("Credentials in the URL are not allowed");
  const port = Number(url.port);
  if (url.port && port !== 80 && port !== 443 && port < 1024)
    throw new SsrfError("Port not allowed");
  if (
    process.env.HOOKS_BASE_URL &&
    bareHost(url.hostname) ===
      bareHost(new URL(process.env.HOOKS_BASE_URL).hostname)
  )
    throw new SsrfError("Destination cannot be a RELAY ingest URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(host, { all: true }).catch(() => {
    throw new SsrfError("Host could not be resolved");
  });
  if (addresses.some(({ address }) => isBlocked(address)))
    throw new SsrfError("Host resolves to a blocked address");
  return { url, address: addresses[0] };
};

const pinnedLookup =
  ({ address, family }) =>
  (hostname, options, callback) =>
    options.all
      ? callback(null, [{ address, family }])
      : callback(null, address, family);

module.exports = { SsrfError, checkUrl, pinnedLookup };
