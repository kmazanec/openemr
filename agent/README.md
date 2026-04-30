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

| Method | Path                       | Returns                                                                  |
| ------ | -------------------------- | ------------------------------------------------------------------------ |
| GET    | `/health`                  | `{ status: 'ok' }` (unauthenticated)                                     |
| POST   | `/v1/agent/echo`           | `{ ok, action: 'echo', fhirUser, received }` framed as SSE — smoke probe |
| POST   | `/v1/agent/respond`        | `{ received: <body>, fhirUser }` (JSON)                                  |
| POST   | `/v1/agent/respond/stream` | `{ received: <body>, fhirUser }` framed as SSE                           |

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

In addition, the service requires:

| Variable                                        | Purpose                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `DATABASE_URL`                                  | Postgres conn string for the LangGraph checkpointer (required).                                                                                                                                                                                                                                        |
| `AGENT_JWT_ISSUER`                              | Expected `iss` claim — OpenEMR's oauth2 base URL, e.g. `https://emr.biograph.dev/oauth2/default` (required).                                                                                                                                                                                           |
| `AGENT_JWT_AUDIENCE`                            | Expected `aud` claim. Default `openemr-clinical-copilot-agent` — matches `AgentTokenMinter::AGENT_CLIENT_ID`.                                                                                                                                                                                          |
| `OPENEMR_JWKS_URL` _or_ `AGENT_JWT_PUBLIC_KEY`  | Where to fetch the verification key. Set `OPENEMR_JWKS_URL` to OpenEMR's public JWKS endpoint (e.g. `http://openemr/oauth2/default/jwk`) for the standard SMART/FHIR pattern; the agent caches keys in-process and refetches on cache miss. Or set `AGENT_JWT_PUBLIC_KEY` to a single JWK as JSON for offline/test deployments. Exactly one is required. |

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

## Authentication

Every `/v1/*` route requires a Bearer JWT minted by the OpenEMR proxy
controller (`AgentTokenMinter`, in
[`interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentTokenMinter.php`](../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentTokenMinter.php)).
`/health` is intentionally open so Docker can probe it.

The verifier (`src/auth/verify.ts`) checks RS256 signature, `iss`,
`aud`, `exp`, and `nbf`, then exposes the principal on the Hono context
as `{ sub, fhirUser, scopes, jti, audience, issuer, expiresAt, raw }`.
`fhirUser` is the `sub` claim (League OAuth2 puts the user identifier
there; the minter uses the practitioner's fhirUser uuid). Verification
keys come from OpenEMR's JWKS endpoint by default (`OPENEMR_JWKS_URL`)
with in-process caching; a single static JWK can be supplied via
`AGENT_JWT_PUBLIC_KEY` for tests or offline deployments. Defense in
depth: requests without a valid token are rejected with `401` even
though the service listens only on the private Docker network.

## Logging

Use `createLogger(component)` from
[`src/observability/logger.ts`](src/observability/logger.ts). It applies
PHI redaction (`firstName`, `dob`, `ssn`, `mrn`, `prompt`, `completion`,
…) up to two levels deep through objects and arrays, censoring matched
fields to `[REDACTED]`. Never concatenate PHI into the log message; pass
it as structured context and let the redactor drop it.

## End-to-end smoke

The smoke action exercises the full trust boundary without any LLM:
browser → OpenEMR session → proxy controller → minted JWT → agent
service → SSE response.

**Prerequisites:**

1. Dev-easy stack up: `docker compose up -d` from
   `docker/development-easy/` (brings up `agent` and `agent-postgres`
   along with the rest).
2. The Clinical Co-Pilot module is registered and enabled. First-time
   registration via the admin UI is documented in the
   [module README](../interface/modules/custom_modules/oe-module-clinical-copilot/README.md).
   `agent.php` returns 500 (`Module … could not be initialized`) until
   the row exists in `modules` with `mod_active=1` and `type=0`.
3. OpenEMR's OAuth2 keys exist and decrypt cleanly. Symptoms of drift:
   `https://localhost:9300/oauth2/default/jwk` returns 500 with `Key in
   drive is not compatible (ie. can not be decrypted) with key in
   database`. Recovery on dev-easy (destroys 295-ish rows of encrypted
   audit-log content, no real PHI):
   ```sh
   # nuke the on-disk drive crypto + oauth2 keypair
   docker compose exec openemr sh -c '
       rm -rf /var/www/localhost/htdocs/openemr/sites/default/documents/logs_and_misc/methods/*
       rm -f /var/www/localhost/htdocs/openemr/sites/default/documents/certificates/oa{public,private}.key'
   # nuke the matching DB rows so OpenEMR regenerates the whole stack
   docker compose exec mysql mariadb -uroot -proot -e \
       "DELETE FROM openemr.\`keys\`"
   # any HTTPS request triggers regeneration
   docker compose exec openemr curl -sk -o /dev/null https://localhost/oauth2/default/jwk
   ```

**Verification:**

1. Sign in to OpenEMR at `http://localhost:8300` (or the HTTPS variant).
2. Visit `http://localhost:8300/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php?action=echo`
   in a new tab — or `curl` it with the session cookie. Expect a single
   SSE frame:
   ```
   data: {"ok":true,"action":"echo","fhirUser":"<uuid-or-uid>","received":null}
   ```
3. Bad-state diagnostics:
   - `500` with `Module … could not be initialized` → module not
     registered (see prerequisite 2).
   - `503` from the proxy with `token_mint_failed` → OpenEMR can't
     decrypt its OAuth2 keys (see prerequisite 3).
   - `401` with empty body and `text/html` content-type → upstream of
     the proxy: usually a missing or expired session.
   - `401` with `{"error":"unauthorized"}` and `text/event-stream` →
     agent rejected the bearer. Check `docker compose logs agent` for
     the verifier rejection reason (typical causes: JWKS fetch failed,
     `iss`/`aud` mismatch).
   - `event: error` SSE frame → proxy reached OpenEMR's session and
     minted a token, but couldn't connect to the agent. Confirm the
     `agent` container is healthy.

The Vitest case at `tests/server/echo.test.ts` covers the agent half of
this round-trip with a stubbed token; this section covers the half
that's a deploy + login.

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
