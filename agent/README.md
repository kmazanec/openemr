# Clinical Co-Pilot — Agent service

Private Node/TypeScript service that runs the Clinical Co-Pilot LangGraph
runtime: orchestration, LLM calls, claim ledger, verification, response
formatting, agent state, observability. Sits behind OpenEMR's proxy
controller — the browser never talks to it directly.

Architecture: [`/ARCHITECTURE.md`](../ARCHITECTURE.md). Build plan and
status: [`/docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md).

## Quickstart

```sh
cd agent
npm install
npm run dev      # tsx watch — http://localhost:8080
curl http://localhost:8080/health
```

## Routes

Phase-1 skeletons (echo only — graph wiring lands in phase 3):

| Method | Path                       | Returns                              |
| ------ | -------------------------- | ------------------------------------ |
| GET    | `/health`                  | `{ status: 'ok' }`                   |
| POST   | `/v1/agent/respond`        | `{ received: <body> }` (JSON)        |
| POST   | `/v1/agent/respond/stream` | `{ received: <body> }` framed as SSE |

## Scripts

| Command                | What it does                                               |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | tsx watch on `src/server/index.ts`                         |
| `npm run build`        | `tsc -p tsconfig.json` → `dist/`                           |
| `npm start`            | Run the compiled `dist/server/index.js`                    |
| `npm run typecheck`    | `tsc -p tsconfig.test.json` (covers `src + tests + evals`) |
| `npm test`             | Vitest, single run                                         |
| `npm run test:watch`   | Vitest, watch mode                                         |
| `npm run lint`         | ESLint (type-aware, `recommended-type-checked`)            |
| `npm run lint:fix`     | ESLint with `--fix`                                        |
| `npm run format`       | Prettier `--write` over the agent dir                      |
| `npm run format:check` | Prettier `--check`                                         |

## Environment variables

| Variable    | Default                      | Purpose                                  |
| ----------- | ---------------------------- | ---------------------------------------- |
| `PORT`      | `8080`                       | HTTP listen port                         |
| `NODE_ENV`  | `development`                | `production` switches off pretty logging |
| `LOG_LEVEL` | `debug` (dev), `info` (prod) | Pino level                               |

Coming in later phases (placeholder — not yet read by any code):

- `ANTHROPIC_API_KEY` — Sonnet 4 calls (phase 3)
- `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING` — observability (phase 6.1)
- `OPENEMR_JWKS_URL` _or_ `AGENT_JWT_PUBLIC_KEY` — bearer-token verification (phase 1.5)

In addition, the service requires:

| Variable       | Purpose                                                         |
| -------------- | --------------------------------------------------------------- |
| `DATABASE_URL` | Postgres conn string for the LangGraph checkpointer (required). |

In dev (`docker/development-easy/`) the value is
`postgresql://agent:agent@agent-postgres:5432/agent`. In prod
(`docker/digitalocean/`) the password comes from `AGENT_PG_PASSWORD` in
`/etc/openemr/.env` and the host is the same `agent-postgres` service
on the internal Docker network.

## Docker

```sh
docker build -t clinical-copilot-agent agent/
docker run --rm -p 8080:8080 clinical-copilot-agent
```

The image is multi-stage, pinned to `node:22-alpine` by digest, runs as
the non-root `node` user, and ships only production deps in the final
layer. A Docker-level healthcheck polls `/health`.

## Layout

```
src/
  server/         HTTP entry (Hono + @hono/node-server, SSE via hono/streaming)
  graph/          LangGraph nodes, edges, state shape (phase 3)
  tools/          Snapshot-fetching tools that call OpenEMR (phase 3)
  verify/         Claim ledger + verification gate (phase 3)
  state/          Postgres checkpointer wiring (phase 1.2)
  observability/  Pino logger with PHI redaction
  config/         Config parsing (phase TBD)
evals/
  fixtures/       Pinned ChartSnapshot JSON per archetype (phase 3.6)
  cases/          Vitest assertions per UC (phase 3.6, 4.x)
  runners/        LangSmith dataset/experiment helpers (phase 3.6)
tests/            Vitest unit + integration tests
```

## Logging

Use `createLogger(component)` from
[`src/observability/logger.ts`](src/observability/logger.ts). It applies
PHI redaction (`firstName`, `dob`, `ssn`, `mrn`, `prompt`, `completion`,
…) up to two levels deep through objects and arrays, censoring matched
fields to `[REDACTED]`. Never concatenate PHI into the log message; pass
it as structured context and let the redactor drop it.

## Deploy target

Single environment, prod only, hostname `emr.biograph.dev`. The agent
service runs as a sibling container to OpenEMR on the same Droplet,
fronted by Caddy on the OpenEMR side only — the agent listens on the
Docker private network and is not publicly reachable. Compose entry
lands in [`/docker/digitalocean/docker-compose.yml`](../docker/digitalocean/docker-compose.yml)
when phase 1.2 wires it in.

## Schema init

Agent state lives in a sibling `agent-postgres` container declared in
[`docker/development-easy/docker-compose.yml`](../docker/development-easy/docker-compose.yml)
and [`docker/digitalocean/docker-compose.yml`](../docker/digitalocean/docker-compose.yml).
The Postgres image starts empty; LangGraph's first-party Postgres
checkpointer (`@langchain/langgraph-checkpoint-postgres`) creates and
migrates its own tables.

Bring-up flow on every boot of the agent service:

1. `start()` in [`src/server/index.ts`](src/server/index.ts) reads
   `DATABASE_URL` and aborts with a non-zero exit if it isn't set.
2. [`createCheckpointer()`](src/state/checkpointer.ts) constructs a
   `PostgresSaver` from the conn string.
3. `await checkpointer.setup()` runs the LangGraph migrations. This is
   idempotent — first boot creates the `checkpoints`, `checkpoint_blobs`,
   `checkpoint_writes`, and `checkpoint_migrations` tables; subsequent
   boots are no-ops once `checkpoint_migrations` is at the latest
   version.
4. The HTTP listener starts only after `setup()` resolves, so a broken
   migration shows up as a failed boot, not a half-up service.

Because LangGraph owns the schema, there are no hand-written migrations
in this repo for agent state. To inspect the schema in dev:

```sh
psql 'postgresql://agent:agent@127.0.0.1:8330/agent' -c '\dt'
```
