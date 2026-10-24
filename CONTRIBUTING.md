# Contributing

## Setup

```
docker compose up -d
cp .env.example .env
npm install
npm run migrate
npm run migrate:test
npm start
```

`docker compose` runs MySQL (host port 3307), Redis (6379) and Mailpit (SMTP 1025, UI http://localhost:8025). Run `npm run worker` in a second terminal to process deliveries. `ROLE=ingest|app|all` (default `all`) selects what `npm start` serves.

The frontend lives in [relay-frontend](https://github.com/parthgupta21/relay-frontend) and expects this API on port 3000.

## Tests

`npm test` migrates `relay_test`, then runs `node --test` serially against real MySQL, Redis and Mailpit, so the compose services must be up. Every behavior change needs a test in `test/`.

## Conventions

- CommonJS, Sequelize models, Koa routes under `routes/`, business logic under `services/`.
- Formatting is Prettier: run `npm run format` before committing; CI runs `npx prettier --check .`.
- No code comments. Use clear names; record decisions in `memory.md`.
- Tenant data is always read through the workspace scope; a record the caller does not own is a 404.
- Commit messages: subject only, imperative mood, under 60 characters.

## Adding a migration

Never edit a migration that has been merged. Create a new one:

```
npx sequelize-cli migration:generate --name add-example-column
```

Write both `up` and `down`, then run `npm run migrate` and `npm run migrate:test`, and update the matching model in `models/`.
