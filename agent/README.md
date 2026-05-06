# Clinical Co-Pilot — Agent service

Private Node/TypeScript service that runs the Clinical Co-Pilot LangGraph
runtime: orchestration, LLM calls, claim ledger, verification, response
formatting, agent state, observability. Sits behind OpenEMR's proxy
controller — the browser never talks to it directly.

**W1 surface (unchanged):** chart-grounded conversational graph; supervisor
+ retriever + synthesize + verify + format pipeline; SSE briefing stream;
PHI-redacting logger; Postgres-backed checkpointer + state stores.

**W2 surface (added):** a separate ingestion pipeline (rasterize → vision
extract → schema-validate → patient-match → persist) reachable from three
invokers — supervisor handoff (`kickoffExtraction`), OpenEMR upload event
(`/v1/agent/extract`), and a CLI for the autosweep cron. Two new
retrievers (`evidenceRetriever` over a Pinecone-indexed guideline corpus,
`documentEvidenceRetriever` over extracted-document chunks) extend the
supervisor's tool set so a single answer can cite chart records,
extracted-document facts, and published guidelines together. The W1
verification gate runs unchanged at the seam — uncited claims still get
dropped.

W1 architecture: [`/ARCHITECTURE.md`](../ARCHITECTURE.md). W1 build plan
and status: [`/docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md).
W2 architecture: [`/W2_ARCHITECTURE.md`](../W2_ARCHITECTURE.md). W2 build
plan: [`/docs/week2plans/`](../docs/week2plans/).

## Quickstart

```sh
cd agent
npm install
npm run dev      # tsx watch — http://localhost:8080
curl http://localhost:8080/health
```

### Host system dependency: Poppler

The §B.3 rasterizer shells out to `pdftoppm` and `pdfinfo` from the
[Poppler](https://poppler.freedesktop.org/) toolkit to convert PDFs to
page PNGs for the vision call. The Docker image installs this
automatically (`apk add poppler-utils` in `Dockerfile`); host-side
tests need it on `PATH`:

- macOS: `brew install poppler`
- Debian/Ubuntu: `apt install poppler-utils`
- Alpine: `apk add poppler-utils`

The rasterizer test suite (`tests/pipeline/rasterizer.test.ts`) skips
itself when `pdftoppm`/`pdfinfo` are absent, so contributors without
Poppler installed will see the suite as skipped rather than failed.

## Routes

| Method | Path                              | Auth      | Purpose                                                                                                                                                                                                                            |
| ------ | --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                         | Open      | Docker healthcheck. Returns `{ status: 'ok' }`.                                                                                                                                                                                    |
| POST   | `/v1/agent/briefing`              | JWT       | §3.4 default-briefing entry. Runs the LangGraph briefing graph and emits the `briefingStream.ts` SSE sequence (`metadata` → `chip-id` → `section/*` → `done` / `error`). Envelope may carry `pendingUploads: [{documentUuid, docType}]`; the supervisor sees that list and picks `kickoffExtraction` per entry before iterating. Each non-terminal supervisor decision emits a `supervisorNarration` SSE frame ("Pulling prior lipid panels to compare.") so the panel's progress line tracks the model's intent. `precompute=true` branch backs §5.3 morning-prep cron. |
| POST   | `/v1/agent/extract`               | JWT       | W2 ingestion-pipeline trigger. Runs rasterize → vision extract → schema-validate → patient-match → persist on a single uploaded document and emits the `pipelineStream.ts` SSE sequence (`pipeline.start` → `pipeline.<stage>.complete` → `pipeline.exit` / `pipeline.error`). One of three pipeline invokers; the conversational panel currently goes through `kickoffExtraction` from the supervisor instead (see [`W2_ARCHITECTURE.md`](../W2_ARCHITECTURE.md) §"Three invokers, one pipeline"), so this route is reserved for the autosweep / CLI / debug paths. Returns 503 `pipeline_unavailable` when the agent boots without pipeline deps wired. |
| GET    | `/v1/agent/latest_conversation`   | JWT       | §3.5 conversation resume. Returns the most recent conversation for `(principal.sub, pid)`, or a specific one when `?conversation=<uuid>` is supplied. Owner-and-patient scoping enforced server-side.                              |
| GET    | `/v1/agent/conversation_history`  | JWT       | §3.5 conversation list. Cursor-paginated by `(updated_at, id)`; scoped to `(principal.sub, pid)`.                                                                                                                                  |
| GET    | `/v1/agent/schedule_briefings`    | JWT       | §5.4 schedule-view annotations. Returns the cached briefings the §5.3 precompute job wrote, keyed by `(practitioner_uuid, date)`. Self-only — `principal.sub` must equal `practitioner_uuid`.                                      |
| POST   | `/v1/agent/respond`               | JWT       | Legacy non-stream echo. Returns `{ received, fhirUser }`. Kept for §1.6 smoke tests.                                                                                                                                                |
| POST   | `/v1/agent/echo`                  | JWT       | §1.6 trust-boundary smoke. Single SSE frame with `{ ok, action: 'echo', fhirUser, received }`.                                                                                                                                      |

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
| `npm run corpus:fetch:uspstf`   | Download every published USPSTF recommendation to `agent/.corpus-cache/uspstf/` (gitignored). Idempotent on `content_sha256`; honors `Crawl-delay: 5`. |
| `npm run corpus:extract:uspstf` | Parse cached HTML into committed chunk files under `agent/data/corpus/uspstf/`; refreshes `fetch-manifest.json` and `index.json`.                     |
| `npm run corpus:fetch:cdc`      | Download CDC clinical-guidance pages (ACIP schedules + notes, opioid prescribing, STI clinical guidance) to `agent/.corpus-cache/cdc/`. Idempotent on `content_sha256`. |
| `npm run corpus:extract:cdc`    | Parse cached CDC HTML into committed chunk files under `agent/data/corpus/cdc/`; refreshes `fetch-manifest.json` and `index.json`.                                       |
| `npm run corpus:fetch:ada`      | Download the ADA Standards of Care in Diabetes—2026 (Introduction + 17 numbered sections) from the open-access PMC mirror to `agent/.corpus-cache/ada/`. Idempotent on `content_sha256`. |
| `npm run corpus:extract:ada`    | Parse cached PMC HTML into committed chunk files under `agent/data/corpus/ada/`; refreshes `fetch-manifest.json` and `index.json`.                                                       |
| `npm run evals:reindex-corpus`  | Embed every chunk under `agent/data/corpus/<source>/` and upsert to Pinecone (namespace `guidelines-v1`). No-ops with a warning when corpus env vars are missing.        |

## Environment variables

| Variable    | Default                      | Purpose                                  |
| ----------- | ---------------------------- | ---------------------------------------- |
| `PORT`      | `8080`                       | HTTP listen port                         |
| `NODE_ENV`  | `development`                | `production` switches off pretty logging |
| `LOG_LEVEL` | `debug` (dev), `info` (prod) | Pino level                               |

Required for the LLM/observability path (Phase 3+):

- `ANTHROPIC_API_KEY` — Sonnet model calls (Synthesize node).
- `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING` — trace
  emission, dataset upload, and the nightly experiment runner. The
  service runs without these set; metric metadata simply doesn't reach
  LangSmith and `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS`
  default to `true` so prompts/completions never reach the trace
  surface.
- `LANGSMITH_TAG_SALT` — HMAC salt for hashing principal/patient
  identifiers into trace tags so the LangSmith UI stays PHI-free
  (§6.1).

Required for the guideline-corpus path (`evals:reindex-corpus`,
`evidenceRetriever`):

- `OPENAI_API_KEY` — embeddings via `text-embedding-3-large` (3072d).
- `PINECONE_API_KEY`, `PINECONE_INDEX_NAME` — target hybrid (sparse +
  dense) index. Create one serverless hybrid index in your Pinecone
  account with dimension `3072`, metric `dotproduct` (required for
  hybrid sparse-dense). Set `PINECONE_INDEX_NAME` to its name.
- `PINECONE_NAMESPACE` — defaults to `guidelines-v1`. Bump the
  namespace (e.g. `guidelines-v2`) before adding a new corpus version
  so old experiments stay comparable.
- The Pinecone index must be created with `metric=dotproduct`,
  dimension 3072, serverless. Cosine indexes do not support sparse
  vectors and the retriever's hybrid query will fail against them.
- `COHERE_API_KEY` — `rerank-v3.5` reranker over Pinecone's top-20.
- `COHERE_RERANK_MODEL` — optional override for the Cohere rerank
  model id; defaults to `rerank-v3.5`.

Required for the W2 ingestion pipeline (panel uploads, vision
extraction, document persistence — see `src/config/spacesEnv.ts`). All
six are required at boot when the pipeline is wired; a partial config
fails closed at parse time. Two IAM identities flow through:
`SPACES_OPENEMR_*` is read+write across the bucket prefix (used by
OpenEMR for canonical-byte uploads on the panel-upload path);
`SPACES_AGENT_*` is read-only on the transient prefix (used by the
pipeline to mint signed URLs for the vision LLM).

- `SPACES_BUCKET` — DigitalOcean Spaces bucket name.
- `SPACES_REGION` — Spaces region (e.g. `nyc3`); the endpoint is
  computed as `https://<region>.digitaloceanspaces.com`.
- `SPACES_OPENEMR_KEY`, `SPACES_OPENEMR_SECRET` — IAM credentials with
  read+write across the bucket prefix.
- `SPACES_AGENT_KEY`, `SPACES_AGENT_SECRET` — IAM credentials with
  read-only access on the transient prefix.
- `SPACES_TRANSIENT_PREFIX` — optional, defaults to `transient`. Path
  prefix for short-lived signed-URL artifacts. Must not contain `/`;
  key helpers add the separator.

In addition, the service requires:

| Variable                                        | Purpose                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `DATABASE_URL`                                  | Postgres conn string for the agent's state store, the LangGraph checkpointer, and the migrations runner (required).                                                                                                                                                                                    |
| `AGENT_JWT_ISSUER`                              | Expected `iss` claim — OpenEMR's oauth2 base URL, e.g. `https://emr.biograph.dev/oauth2/default` (required).                                                                                                                                                                                           |
| `AGENT_JWT_AUDIENCE`                            | Expected `aud` claim. Default `openemr-clinical-copilot-agent` — matches `AgentTokenMinter::AGENT_CLIENT_ID`.                                                                                                                                                                                          |
| `OPENEMR_JWKS_URL` _or_ `AGENT_JWT_PUBLIC_KEY`  | Where to fetch the verification key. Set `OPENEMR_JWKS_URL` to OpenEMR's public JWKS endpoint (e.g. `http://openemr/oauth2/default/jwk`) for the standard SMART/FHIR pattern; the agent caches keys in-process and refetches on cache miss. Or set `AGENT_JWT_PUBLIC_KEY` to a single JWK as JSON for offline/test deployments. Exactly one is required. |
| `OPENEMR_BASE_URL`                              | Base URL the §3.1 callback tools use to reach OpenEMR's `snapshot.php` endpoint, e.g. `http://openemr` (internal Docker DNS). Wired in §3.2 when the graph's `Retrieve` node is built; not required for `/health` or echo. |

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

## Evals

Three layers, documented in [`/CLAUDE.md` § "Agent evals"](../CLAUDE.md):

- **Per-MR Vitest gate** — `evals/cases/<suite>/*.test.ts`, run by
  `npm test`. Stubs the synthesizer; asserts deterministic-gate
  behavior. CI runs this on every push.
- **Fixture data** — `evals/fixtures/<suite>/*.json`, regenerated by
  `npm run evals:regenerate-fixtures` (which calls every per-suite
  regenerator under `evals/fixtures/regenerate-*.ts`). Never hand-edit
  the JSON.
- **LangSmith experiment** — `evals/runners/cli.ts`. Upload every
  suite's dataset with `npm run evals:upload-dataset`; run the
  experiment against the real Anthropic synthesizer (and supervisor)
  with `npm run evals:experiment`. Both iterate the suite registry
  in `evals/runners/suites.ts`; both no-op per-suite without
  `LANGSMITH_API_KEY` (experiment also requires `ANTHROPIC_API_KEY`).
  Every suite runs against the real model unless explicitly flagged
  — the `eval-suite skip policy` test in `suites.test.ts` enforces
  this. Suites that need Pinecone+Cohere (`conversational-graph`,
  `end-to-end`) run all rows live; rows whose verdict requires
  guideline retrieval will mismatch their dataset expectation when
  the corpus env vars aren't wired (the right signal — silently
  skipping the row would let drift in).

Adding a new suite is one new `evals/runners/<name>Suite.ts` plus an
entry in `suites.ts`. The CLI picks it up automatically.

Headline result counts and the per-suite breakdown live in
[`docs/EVAL_RESULTS.md`](../docs/EVAL_RESULTS.md), refreshed each
submission.

## Guideline corpus

Three scripts, run in order. The first two produce committed source of
truth; the third indexes it into Pinecone for runtime retrieval by the
`evidenceRetriever` graph node (§C.3).

```sh
# 1. Fetch every published USPSTF recommendation HTML into the local
#    gitignored cache. Honors the publisher's robots.txt Crawl-delay: 5.
#    Re-runs are conditional on content_sha256, so the second run is
#    nearly free.
npm run corpus:fetch:uspstf

# 2. Parse cached HTML into one markdown chunk per (recommendation,
#    section) under agent/data/corpus/uspstf/. Refreshes fetch-manifest.json
#    and index.json. Body text is verbatim from the publisher's DOM —
#    selectors that fail emit warnings, never invent content. Commit the
#    diff.
npm run corpus:extract:uspstf

# 3. Embed every chunk and upsert to Pinecone (namespace guidelines-v1).
#    Required env: OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_NAME.
#    No-ops with a warning when any are missing. Re-runnable; chunk IDs
#    are stable so it upserts in place rather than appending.
npm run evals:reindex-corpus
```

Step 3 is what populates Pinecone. Run it once after the index is
provisioned, and again whenever steps 1–2 produce a chunk diff or the
namespace is wiped. CI does **not** reindex — the assumption is that
the namespace already holds the corpus before retrieval-eval cases run.

### Sources currently in the corpus

| Source  | License tier      | Surfaces                                                                                                              |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| USPSTF  | `public_domain`   | All published preventive-services recommendations (recommendation summary + clinical considerations + practice notes) |
| CDC     | `public_domain`   | ACIP adult + child/adolescent immunization schedules and notes; 2022 opioid prescribing guideline at-a-glance; STI clinical-guidance sub-pages |
| ADA     | `fair_use_cds` ¹  | Standards of Care in Diabetes—2026: Introduction & Methodology + sections 1–17 (Improving Care, Diagnosis, Prevention, Comprehensive Evaluation, Health Behaviors, Glycemic Goals, Technology, Obesity, Pharmacology, Cardiovascular, CKD, Retinopathy/Neuropathy/Foot, Older Adults, Children, Pregnancy, Hospital, Advocacy) |

¹ The ADA Standards of Care are copyrighted by the American Diabetes
Association, freely accessible for clinical-decision-support research,
and **require an explicit ADA license for production deployment**. The
synthetic-data demo posture is unaffected; production replacement is
expected before any patient-facing use.

CDC is added via the same fetch + extract + reindex flow:

```sh
npm run corpus:fetch:cdc       # cache HTML under agent/.corpus-cache/cdc/
npm run corpus:extract:cdc     # emit chunks under agent/data/corpus/cdc/
npm run evals:reindex-corpus   # picks up every source under data/corpus/* automatically
```

ADA follows the same shape, with one fetch-time choice: the publisher's
direct site (`diabetesjournals.org`) returns a Cloudflare JS-challenge
to scripted fetches, so the fetcher targets the open-access PMC mirror
(`pmc.ncbi.nlm.nih.gov/articles/PMC<id>/`) where every Standards-of-Care
section is published as a separate article. Each chunk's frontmatter
records both `url` (the PMC article — what was fetched) and
`publisher_url` (the canonical `https://doi.org/10.2337/dc26-S<NN>`
link — what citation popovers should display to users).

```sh
npm run corpus:fetch:ada       # cache HTML under agent/.corpus-cache/ada/
npm run corpus:extract:ada     # emit chunks under agent/data/corpus/ada/
npm run evals:reindex-corpus   # picks up every source under data/corpus/* automatically
```

The fetch + extract pipeline is source-agnostic by convention: future
publishers (ACC/AHA, AGS Beers, etc.) plug in by adding a new
`agent/scripts/fetch-<source>-corpus.ts` + `extract-<source>-corpus.ts`
pair plus a new `agent/data/corpus/<source>/` directory. The reindex
script iterates `agent/data/corpus/*/index.json` automatically.

Provenance per chunk: `fetched_at` + `content_sha256` are threaded
through the YAML frontmatter, the per-source `index.json`, and the
Pinecone vector metadata. Every retrieved citation traces back to the
exact publisher fetch that produced it.

## Authentication

Every `/v1/*` route requires a Bearer JWT minted by the OpenEMR proxy
controller (`AgentTokenMinter`, in
[`interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentTokenMinter.php`](../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentTokenMinter.php)).
`/health` is intentionally open so Docker can probe it.

The verifier (`src/auth/verify.ts`) checks RS256 signature, `iss`,
`aud`, `exp`, and `nbf`, then exposes the principal on the Hono context
as `{ sub, fhirUser, scopes, jti, audience, issuer, expiresAt, raw }`.
`sub` is the practitioner's bare `users.uuid`; `fhirUser` is the SMART
URI claim (`{baseUrl}/Practitioner/{uuid}`) that the proxy mints
alongside `sub`. If a token arrives without the `fhirUser` claim (older
mint, regression) the verifier falls back to `sub` so downstream code
keeps working but the missing claim is logged. Verification keys come
from OpenEMR's JWKS endpoint by default (`OPENEMR_JWKS_URL`) and are
selected by `kid`; a single static JWK can be supplied via
`AGENT_JWT_PUBLIC_KEY` for tests or offline deployments. Defense in
depth: requests without a valid token are rejected with `401` even
though the service listens only on the private Docker network.

### Error envelope

The proxy and the agent share a single error shape but two transports,
chosen by whether the SSE stream has started:

- **Pre-stream errors** — auth failure, policy gate denial, mint
  failure, validation. HTTP status code (`401` / `403` / `503`) +
  `Content-Type: application/json` + body `{"error": "<code>"}`.
- **In-stream errors** — upstream connection drop, mid-stream tool
  failure. After SSE headers have flushed the response is locked into
  `text/event-stream`, so the same JSON payload is wrapped in
  `event: error\ndata: <json>\n\n`.

A browser `EventSource` consumer should subscribe to the `error` event
and parse `event.data` with the same decoder used for the JSON variant.
The proxy guards the boundary with `headers_sent()`; if a future
refactor moves a deny check inside `streamUpstream`, the error still
reaches the client as a typed SSE frame instead of a half-written HTTP
response.

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
The Postgres image starts empty.

Two schemas share that database:

- **LangGraph's checkpointer schema** (`checkpoints`, `checkpoint_blobs`,
  `checkpoint_writes`, `checkpoint_migrations`) is owned by
  `@langchain/langgraph-checkpoint-postgres`. We don't migrate those —
  the third-party module manages its own lifecycle via
  `PostgresSaver.setup()`.
- **Agent application schema** (`unverified_claims`, `conversations`,
  `conversation_messages`, `conversation_suggestion_chips`,
  `schedule_briefings`, `extraction_artifacts`,
  `extracted_fact_dispositions`) is owned by us and managed via
  [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate).
  Migrations live in [`agent/migrations/`](migrations/) as
  `<unix-ms>_<name>.sql` files with `-- Up` and `-- Down` blocks; each
  one runs exactly once per database, tracked in the `pgmigrations`
  table.

Bring-up flow on every boot of the agent service:

1. `start()` in [`src/server/index.ts`](src/server/index.ts) reads
   `DATABASE_URL` and aborts with a non-zero exit if it isn't set.
2. `await runMigrations({ databaseUrl })` applies any pending
   application-schema migrations. A pending migration that fails
   throws — the agent refuses to serve briefings against a
   half-applied schema. Re-running on an up-to-date database is a
   no-op (logs `no migrations to apply`).
3. [`createCheckpointer()`](src/state/checkpointer.ts) constructs a
   `PostgresSaver` and calls its own `setup()` for the LangGraph
   tables. Idempotent the same way.
4. State-store factories wire up against the now-provisioned schema.
5. The HTTP listener starts only after every step above resolves, so a
   broken migration shows up as a failed boot, not a half-up service.

To inspect the schema in dev:

```sh
psql 'postgresql://agent:agent@127.0.0.1:8330/agent' -c '\dt'
```

### Running migrations manually

Boot applies migrations automatically; the npm scripts are for ops who
want to migrate before swapping container versions, or for spinning up
a fresh database without booting the service.

```sh
DATABASE_URL=... npm run migrate:up                    # apply pending migrations
DATABASE_URL=... npm run migrate:down                  # roll back the most recent
DATABASE_URL=... npm run migrate -- redo               # down + up the most recent
DATABASE_URL=... npm run migrate:create my_migration   # scaffold a new file
```

See [`migrations/README.md`](migrations/README.md) for the migration
file format, conventions for new migrations, and how to handle the
rare rename-an-applied-migration case.

### First boot against an existing populated database

Production was schema-managed by inline `CREATE TABLE IF NOT EXISTS`
boot DDL in each `*Store.ts` before this MR. On the first boot of the
new code, `pgmigrations` doesn't exist yet, so node-pg-migrate creates
it and treats every baseline migration as pending. Each baseline
migration uses `IF [NOT] EXISTS` everywhere, so the up-blocks are
no-ops against the already-populated tables; node-pg-migrate just
records the names in `pgmigrations`. No data is touched. From the
second boot forward, the runner is at parity with the filesystem and
new migrations layer on normally.

### `pg` dependency

`pg` is a direct dependency of this package, used by the state-store
factories and `node-pg-migrate`. LangGraph also pulls it transitively
for the checkpointer; we make the dependency explicit so direct uses
don't depend on a transitive pin.
