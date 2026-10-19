# RELAY backend - working log

RELAY is a hosted, multi-tenant webhook capture and forwarding SaaS: it gives each tenant public ingest URLs, stores every request byte-exact, and (later phases) forwards with retries.
Design doc: https://claude.ai/code/artifact/f69bd9a8-ff89-4860-81d7-391cddee88a4

## Structure decision and deviations from the doc

- Layout follows the user's work repo "upi-collect" (index.js, logging.js, namespace.js, config/, database/, models/, migrations/, routes/, middleware/, services/, utils/, test/), not the doc's `modules/` layout.
- Sequelize + sequelize-cli instead of mysql2 + Knex. CommonJS.
- console logging via cls-hooked namespace (`level=[INFO] requestId=... method=... url=... msg="..."`) instead of pino. Ingest slugs are masked to the first 6 chars in the url field.
- node:test + supertest instead of Vitest.
- Phase 1 sends email inline (nodemailer); BullMQ arrives in phase 2.
- Redis runs in compose but is not used yet.
- No rate limiting, quota counter, queue or sockets in phase 1.

## How to run

- `docker compose up -d` (MySQL 3307->3306, Redis 6379, Mailpit SMTP 1025 / UI http://localhost:8025)
- `cp .env.example .env`
- `npm install`
- `npm run migrate` (dev DB `relay`), `npm run migrate:test` (`relay_test`)
- `npm start` (`ROLE=ingest|app|all`, default all)
- `npm test` (migrates the test DB, then runs node:test serially against real MySQL and Mailpit)

## Phase checklist (doc section 21)

- [x] Phase 1: backend foundation, auth, endpoints, ingest, inspector API (26 tests passing)
  - [x] B1 scaffold
  - [x] B2 migrations and models
  - [x] B3 registration, verification, sessions
  - [x] B4 endpoints, ingest, event inspector API
- [ ] Phase 2: forwarding (doc phase 2; retries, sweeper, semaphores and replay come later)
  - [x] Stage 1: destinations, deliveries, delivery_attempts tables, SSRF checks, encrypted signing secrets, destination API
  - [ ] Stage 2: ingest creates deliveries, BullMQ queue, worker, read API
- [ ] Phase 3: realtime (Socket.IO), replay
- [ ] Phase 4: API tokens, usage, rate limits, quotas
- [ ] Phase 5: analytics, retention, account deletion, admin
- [ ] Phase 6: hardening, deploy, observability

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

## Known gaps

- Endpoint quota check is count-then-insert, so two concurrent creates can exceed the limit by one.
- `events.method` is VARCHAR(10); HTTP methods longer than 10 chars (e.g. UNSUBSCRIBE) would fail insert with a 500.
- Email is sent inline during the request; slow SMTP slows the response.
- Phase 2+ not started.
