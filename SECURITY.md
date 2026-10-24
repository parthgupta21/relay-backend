# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately at https://github.com/parthgupta21/relay-backend/security/advisories/new. Do not open a public issue.

## Supported versions

Only the `main` branch is supported.

## Controls in the code

- Outbound delivery (`services/ssrf.js`) only connects to addresses ipaddr.js classifies as `unicast`; IPv4-mapped IPv6 is converted to IPv4 first. `SSRF_ALLOWLIST` is for dev and test and the process refuses to load it with `NODE_ENV=production`.
- Destination signing secrets are stored encrypted with AES-256-GCM using `RELAY_ENCRYPTION_KEY`.
- Passwords are hashed with argon2id.
- Authentication uses cookie sessions.
- State-changing requests are checked against the allowed `Origin` (`middleware/originCheck.js`).
- Workspace data is scoped per tenant; a resource owned by another workspace returns 404.
