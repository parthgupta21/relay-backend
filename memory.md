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
- [ ] Phase 1: backend foundation, auth, endpoints, ingest, inspector API
  - [x] B1 scaffold
  - [ ] B2 migrations and models
  - [ ] B3 registration, verification, sessions
  - [ ] B4 endpoints, ingest, event inspector API
- [ ] Phase 2: destinations, deliveries, queue worker, retries
- [ ] Phase 3: realtime (Socket.IO), replay
- [ ] Phase 4: API tokens, usage, rate limits, quotas
- [ ] Phase 5: analytics, retention, account deletion, admin
- [ ] Phase 6: hardening, deploy, observability

## Decisions
- Request context uses cls-hooked `runAndReturn` per request; the Koa ctx is stored in it so console.* can read method and url.
- errorHandler converts any non-AppError into 500 INTERNAL with a generic message; the real error is logged.
- Unmatched routes fall through to the NOT_FOUND envelope.

## Known gaps
- Phase 2+ not started.
