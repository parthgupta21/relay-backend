# RELAY backend - working log

RELAY is a hosted, multi-tenant webhook capture and forwarding SaaS: it gives each tenant public ingest URLs, stores every request byte-exact, and (later phases) forwards with retries.
Design doc: https://claude.ai/code/artifact/f69bd9a8-ff89-4860-81d7-391cddee88a4

## Structure decision and deviations from the doc

- Layout follows the user's work repo "upi-collect" (index.js, logging.js, namespace.js, config/, database/, models/, migrations/, routes/, middleware/, services/, utils/, test/), not the doc's `modules/` layout.
- Sequelize + sequelize-cli instead of mysql2 + Knex. CommonJS.
- console logging via cls-hooked namespace (`level=[INFO] requestId=... method=... url=... msg="..."`) instead of pino. Ingest slugs are masked to the first 6 chars in the url field.
- node:test + supertest instead of Vitest.
- Phase 1 sends email inline (nodemailer); BullMQ arrives in phase 2.
- Redis (BullMQ) is used from phase 2 forwarding: the ingest side enqueues, `worker.js` consumes.
- No rate limiting, quota counter, queue or sockets in phase 1.

## How to run

- `docker compose up -d` (MySQL 3307->3306, Redis 6379, Mailpit SMTP 1025 / UI http://localhost:8025)
- `cp .env.example .env`
- `npm install`
- `npm run migrate` (dev DB `relay`), `npm run migrate:test` (`relay_test`)
- `npm start` (`ROLE=ingest|app|all`, default all) in one terminal and `npm run worker` in a second terminal. No app containers are used locally; compose only runs MySQL, Redis and Mailpit.
- `npm test` (migrates the test DB, then runs node:test serially against real MySQL, Redis and Mailpit). Tests use the queue `deliveries-test`, so a dev worker never picks up test jobs.

## Phase checklist (doc section 21)

- [x] Phase 1: backend foundation, auth, endpoints, ingest, inspector API (26 tests passing)
  - [x] B1 scaffold
  - [x] B2 migrations and models
  - [x] B3 registration, verification, sessions
  - [x] B4 endpoints, ingest, event inspector API
- [x] Phase 2: forwarding
  - [x] Stage 1: destinations, deliveries, delivery_attempts tables, SSRF checks, encrypted signing secrets, destination API
  - [x] Stage 2: ingest creates deliveries, BullMQ queue, worker, outbound HTTP, read API (56 tests passing)
- [x] Phase 3: retries, semaphores, sweeper, replay, retention (84 tests passing)
  - [x] A: retries with backoff and jitter, status classification
  - [x] B: per-destination and per-workspace concurrency semaphores
  - [x] C: sweeper for stuck and missed deliveries
  - [x] D: manual replay with Idempotency-Key
  - [x] E: retention purge
- [x] Phase 4: realtime and limits
  - [x] Socket.IO live updates, API tokens (Bearer), usage metering, per-endpoint rate limit, daily and monthly quotas
- [x] Phase 5: analytics, account deletion, admin
  - [x] `GET /analytics/deliveries`, `POST /account/delete` (tombstone, purged by retention), operator admin API with `audit_log`, `npm run operator`
- [x] Phase 6: hardening, deploy, observability
  - [x] Per-IP auth and account-delete rate limits, purge of expired sessions and email tokens, Prometheus metrics on `METRICS_PORT`, JSON logs (`LOG_FORMAT=json`), access log, `docker-compose.prod.yml`, nginx web image with strict CSP, GHCR deploy workflow
- Final state: 221 tests in 28 files (209 `test(` lines, where the SSRF host loop in `test/ssrf.test.js` counts 13 tests as one line). Production-stack smoke test passed 8/8. Latest backend commit before the docs commits: a73d7f5.

## Decisions

- Request context uses cls-hooked `runAndReturn` per request; the Koa ctx is stored in it so console.* can read method and url.
- errorHandler converts any non-AppError into 500 INTERNAL with a generic message; the real error is logged.
- Unmatched routes fall through to the NOT_FOUND envelope.

- Installed versions are newer than the doc assumed: @koa/router 15, koa 3, zod 4, raw-body 4 (ESM-only package: use `const { getRawBody } = require("raw-body")`).
- Ingest wildcard is `/h/:slug{/*rest}`; verified for `/h/slug`, `/h/slug/`, `/h/slug/a/b`.
- Tenant scoping: `Endpoint.getOwned` and `Event.getOwned` go through the `forWorkspace` scope; not owned is always 404.
- Any Sequelize ConnectionError maps to 503 SERVICE_UNAVAILABLE (verified by stopping MySQL).
- Events list cursor is base64url JSON `{receivedAt, id}` with the internal event id, as specified; it is opaque to clients.
- Ingest clips path to 2048, content-type and idempotency key to 255 so oversize values never cause a DB error.
- `createdAt: "created_at"` in model options renames the attribute, not the column; removed from every model, since `underscored: true` already maps the column.
- Locally `APP_BASE_URL=http://localhost:5173` (the SPA, which proxies `/api` and `/h`): it is the CSRF Origin and the base of email links. `HOOKS_BASE_URL` stays on the API port. End-to-end flow through the SPA proxy verified on 2026-10-20.
- Destination signing secret: AES-256-GCM with RELAY_ENCRYPTION_KEY (32-byte base64), stored as iv(12) + tag(16) + ciphertext. The secret is `whsec_` + 32 random bytes base64url and is returned only by create and rotate-secret.
- SSRF (services/ssrf.js) allows only addresses that ipaddr.js ranges as `unicast`. This is stricter than the doc blocklist (tunnel and benchmarking ranges are blocked too). IPv4-mapped IPv6 is converted to IPv4 first.
- SSRF_ALLOWLIST (CIDRs, dev/test only): ssrf.js throws at load if it is set with NODE_ENV=production. Local `.env` uses 127.0.0.1/32 so a local receiver works.
- The `max_destinations` quota counts non-deleted destinations per endpoint, including disabled ones.
- Destinations are soft-deleted with Sequelize paranoid mode (`deleted_at`).
- Delivery flow: ingest inserts the event and one `pending` delivery per active destination in one transaction, then `addBulk` enqueues jobs `d{id}-a1` on queue `deliveries`. The worker claims with a conditional UPDATE, re-runs the SSRF check, sends with a pinned lookup, then inserts the attempt and updates the delivery in one transaction after the HTTP call.
- ioredis is installed explicitly because bullmq 6 lists it only as an optional peer dependency. The producer connection uses `enableOfflineQueue: false`, and ingest also checks `connection.status === "ready"` first: BullMQ `addBulk` otherwise waits for a connection forever (verified: ingest hung with Redis down before that check).
- Response bodies are read up to 64KB, then the socket is destroyed.
- Retries: 2xx succeeds; 408, 429, 5xx, timeout and network_error are retryable; 3xx, other 4xx and blocked are not. Delay before attempt n is `min(cap, base * 2^(n-2))` with equal jitter (half fixed, half random); `Retry-After` (seconds or HTTP date) on 429/503 wins if longer, capped. A retry is a delayed BullMQ job `d{id}-a{n+1}` added after the DB commit. Out of attempts gives `failed`/`exhausted`.
- `enqueueDeliveries` derives jobId (`d{id}-a{attemptCount+1}`) and delay (`nextAttemptAt - now`) from the delivery row, so ingest, retry, sweeper and replay share it. BullMQ drops duplicate jobIds, which makes the sweeper safe to re-add.
- Semaphores (`services/semaphore.js`): Redis sorted sets `sem:dst:{id}` and `sem:ws:{id}` (prefixed `test:` under NODE_ENV=test), member = job id, score = expiry (now + 60s). One Lua script prunes expired entries and adds to both sets or neither. The worker (`processJob`) acquires before claiming; on refusal it does `moveToDelayed` 2-5s and throws `DelayedError`. Release is in a `finally`; a crashed worker's slot expires after 60s. The semaphore reuses the producer connection from queue.js.
- Scheduled work uses `setInterval` in worker.js, not BullMQ repeatable jobs: sweep and purge are idempotent and safe to run on every worker replica at once (conditional UPDATEs, deterministic jobIds, deleting the same rows twice is harmless), so a repeatable job would add Redis scheduler state for no gain. Cost: with N workers each runs the sweep (more DB reads, no correctness issue).
- Sweeper (`services/sweeper.js`): `pending`/`retry_scheduled` with `next_attempt_at` older than 60s, or `in_flight` with `locked_until` in the past, 500 per run. Stuck `in_flight` becomes `retry_scheduled` with `next_attempt_at = now` (the crashed attempt counts) or `failed`/`exhausted`. The reset is a conditional UPDATE on `status='in_flight'` and the same `locked_until`, so a delivery that finished meanwhile is not touched. Ingest and replay always set `next_attempt_at`, so no NULL case exists.
- Idempotency (`middleware/idempotency.js`): Redis key `idem:{workspaceId}:{key}`, TTL 24h, value JSON `{fingerprint, response?}`. Fingerprint is sha256 of `METHOD path\nJSON(body)` (parsed body, so key order matters). SET NX reserves, a reservation without `response` means in progress (409 CONFLICT), a different fingerprint gives 422 IDEMPOTENCY_KEY_REUSED, a thrown error deletes the reservation, success overwrites it with `{status, body}` for replay. Redis was chosen over a DB table to avoid a migration and because TTL expiry is built in.
- Replay quota: Redis counter `replays:{workspaceId}:{yyyymmddhh UTC}` incremented once per replay request (not per delivery created), 100 per hour, `429 RATE_LIMITED` with `Retry-After` (services/replay.js). It is checked after ownership and validation, and only on requests that reach the handler (idempotent replays of a stored response do not count).
- Retention (`services/retention.js`): per workspace, delete events older than `retention_days` in batches of 1000 by id; deliveries and attempts go through the existing `ON DELETE CASCADE` foreign keys. Hourly from worker.js.
- Env knobs: `RETRY_BASE_MS` (30000), `RETRY_CAP_MS` (3600000), `DESTINATION_CONCURRENCY` (5), `WORKSPACE_CONCURRENCY` (20), `SWEEPER_INTERVAL_MS` (30000), `RETENTION_INTERVAL_MS` (3600000). All are read lazily with defaults; none are in `.env.example`.
- Delivery object (`Delivery.present`) now includes `trigger` and `replayOf` (original delivery publicId or null); `Delivery.belongsTo(Delivery, as "replayOf")` must be included wherever `present()` is called.

- Realtime: producers publish JSON to one Redis pub/sub channel (`realtime`, `test:realtime` under NODE_ENV=test) on the producer connection; each socket process has its own subscriber and emits to the room `ws:<workspace id>`. A plain pub/sub channel is used instead of @socket.io/redis-adapter because only server-to-room broadcast is needed, not cross-node socket management.
- Realtime auth: the handshake reads `relay_sid` from the Cookie header and resolves it with `Session.findActive`; no cookie or no active session gives `UNAUTHENTICATED`, and a DB error gives `SERVICE_UNAVAILABLE`. A present Origin that differs from APP_BASE_URL's origin is refused (same check as originCheck).
- Realtime payloads carry public ids only: `event.created` {endpointId, eventId}, `delivery.updated` {deliveryId, eventId, status}. The workspace id is in the Redis message for routing but never emitted.
- Sockets attach in every role except `ingest`.

## Known gaps

Found in the production smoke test:

- Plain-HTTP login returns 500 when `NODE_ENV=production`: the session cookie is `Secure`. It needs HTTPS, or `X-Forwarded-Proto: https` from a TLS proxy.
- The SSRF guard blocks NAT64 `64:ff9b::/96` destinations.
- A 403 on `/admin` can appear in `relay_http_requests_total` with a raw route-regex `route` label.
- nginx's error log may include an ingest slug on upstream errors. The access log is masked.
- `OPTIONS` (CORS preflight) requests sent to an ingest URL are captured as events and count toward rate limit and quota, because ingest sends no CORS headers.

Open items from the build:

- Endpoint quota check is count-then-insert, so two concurrent creates can exceed the limit by one.
- `events.method` is VARCHAR(10); HTTP methods longer than 10 chars (e.g. UNSUBSCRIBE) would fail insert with a 500.
- Forgot-password and resend-verification do not await the mail send. The token insert is still awaited, which leaves a small timing signal that reveals whether an account exists.
- The ingest-host check in `checkUrl` compares hostnames exactly (aliases, IP literals and CNAMEs pass). The `X-Relay-Delivery-Id` loop guard in ingest is the real protection.
- API tokens: a suspended or deleted workspace gets 403 on `/auth/me` and `/auth/logout` too, so such a user cannot log out through the API. Realtime sockets reject non-active workspaces but that path has no test. The `router.use(auth.withApiToken)` calls in child routers match every `/api/v1/*` path, so `/tokens` must stay mounted before them. Token actions write no audit rows beyond create and revoke, and password reset does not revoke tokens. The Bearer regex is duplicated in `originCheck.js` and `auth.js`.
- Known audit gaps with no fix yet (see RELAY_HARDENING.md): L1 Sec-Fetch-Site CSRF hardening, L3 port oracle, L6 signature does not cover ids, L7/C12 production needs TRUST_PROXY, L8 session and token lifecycle, L11 out of scope, C13 idempotency 409 race.
- If Redis is down or not yet connected, ingest still returns 200 and logs `enqueue skipped`. The deliveries stay `pending` and the sweeper enqueues them once `next_attempt_at` is more than 60s old (so recovery takes 60-90s after Redis returns).
- The semaphore and idempotency code use the producer Redis connection (`enableOfflineQueue: false`). A job that starts before that connection is ready fails and is only recovered by the sweeper; replay requests fail with 500 if Redis is down.
- Semaphore slots are keyed by job id with a fixed 60s expiry. A delivery attempt longer than 60s (timeoutMs max is 30s plus connect time) cannot outlive its slot in practice, but the slot is not renewed.
- A job refused by the semaphore is moved to delayed 2-5s later with no limit on how many times, so a saturated destination keeps its queued jobs cycling.
- Replaying a delivery whose destination was deleted or disabled still creates the delivery; the worker then fails it as `destination_disabled`.
- Idempotency fingerprints use the parsed JSON body, so the same logical body with different key order counts as a different request. The 409 in-progress path has no automated test.
- Replay quota counts requests, not deliveries created; one event replay to several destinations costs 1.
- Retention deletes events only; Redis idempotency keys and the `audit_log` are not purged. Several worker replicas all run the sweep and purge on their own timers.
- A manual replay of a delivery that is itself an original keeps `replay_of_id` pointing to that delivery only, not to the root of a replay chain.
- The forwarded request goes to the destination URL exactly as stored; the original ingest path and query string are not appended.
- SIGTERM/SIGINT graceful shutdown in worker.js is implemented but was not exercised on Windows, where signals terminate the process.
- The claim increments `attempt_count` even when the delivery is then failed as `destination_disabled` with no attempt row.
- Realtime: the sweeper and replay do not publish yet. An open socket is not closed on logout or session expiry. Publishes are dropped while Redis is down (warning logged); the UI should fall back to polling.
- Realtime: more than one app instance needs sticky sessions (polling transport); the SPA must proxy /socket.io with ws enabled.
