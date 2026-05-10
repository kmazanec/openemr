# Production runbook — DigitalOcean deploy

Operational procedures for the OpenEMR + Clinical Co-Pilot stack
running on a single 4 GB / 2 vCPU Droplet. Deployment layout, build
flow, and rollback are in [`infra/README.md`](../infra/README.md). This
file covers what to do **after** something is already running.

All commands assume you are on the Droplet, in `/etc/openemr/`, where
`docker-compose.yml` lives. SSH in as the `gitlab-runner` user (or
escalate to it via `sudo -iu gitlab-runner`) so file ownership stays
consistent with the deploy pipeline.

---

## Agent service down

**Symptoms.** The Clinical Co-Pilot panel in OpenEMR shows
*"The AI service is temporarily unavailable…"*. The chart page itself
still loads — the panel is intentionally non-blocking.

**Confirm.**

```sh
docker compose ps agent
docker compose logs agent --tail=200
```

Look for `agent` in `restarting` or `exited` state, or for repeated
errors in the logs (Anthropic 429s, Postgres connection refusals,
LangGraph checkpointer errors).

**Graceful-degradation guarantee.** When the agent is unreachable, the
proxy at `/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php`
returns `503` and the panel surfaces a user-facing error message via
`renderFatalError()` in
`interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js`.
The rest of OpenEMR remains usable. Do not page on this — only on
**chart-page** failures.

**Recover.**

```sh
docker compose up --detach --force-recreate agent
docker compose logs agent --follow
```

If the agent comes up healthy and starts serving briefings, you're done.
If it crash-loops:

1. Check `docker compose logs agent-postgres` — agent depends on a
   healthy Postgres.
2. Check `/etc/openemr/.env` has `ANTHROPIC_API_KEY` and
   `LANGSMITH_API_KEY` set; an empty key produces 401s on every
   briefing.
3. Check `docker compose logs openemr` for `/oauth2/default/jwk`
   serving — the agent fetches the JWKS at boot and refuses to start
   if the JWKS endpoint is unreachable.

---

## Postgres backup restore

Backups are produced by the `agent-pg-backup` sidecar (see
`docker/digitalocean/agent-pg-backup/`). Daily dumps land in DO Spaces
under `s3://$SPACES_BUCKET/agent-postgres/daily/` and weekly snapshots
under `…/weekly/`.

**Data-loss window.** Up to 24 hours since the last `02:30 UTC` run.
Acceptable for the agent's data — chart data lives in MySQL, which is
*not* covered by this backup (MySQL backup is out of scope for §6.3).

**Restore steps.**

```sh
# 1. Identify the dump you want.
docker compose run --rm agent-pg-backup \
    aws s3 ls "s3://$SPACES_BUCKET/agent-postgres/daily/" \
    --endpoint-url "https://$SPACES_REGION.digitaloceanspaces.com"

# 2. Pull the dump locally.
DUMP=agent-20260501-20260501T023000Z.sql.gz   # adjust to chosen file
docker compose run --rm agent-pg-backup \
    aws s3 cp \
    "s3://$SPACES_BUCKET/agent-postgres/daily/$DUMP" "/backups/$DUMP" \
    --endpoint-url "https://$SPACES_REGION.digitaloceanspaces.com"

# 3. Stop services that talk to agent-postgres.
docker compose stop agent agent-pg-backup

# 4. Drop and recreate the agent-postgres volume.
docker compose rm --force --stop agent-postgres
docker volume rm openemr_agentpgvolume
docker compose up --detach agent-postgres
docker compose exec agent-postgres pg_isready --user agent --dbname agent

# 5. Restore the dump. The backup container has psql + the gz file
#    in the named-volume mount, so we run it from there.
docker compose run --rm --entrypoint sh agent-pg-backup -c "
    gunzip -c /backups/$DUMP \
    | PGPASSWORD=\$POSTGRES_PASSWORD psql \
        --host=agent-postgres --username=agent --dbname=agent
"

# 6. Bring the agent stack back up.
docker compose up --detach agent agent-pg-backup
```

Verify briefings still work end-to-end before declaring restore done —
fire one from the OpenEMR UI on a known patient.

**Manual ad-hoc backup** (e.g. before a risky migration):

```sh
docker compose run --rm agent-pg-backup once
```

Runs `pg_dump` + S3 upload + retention prune once, then exits. Useful
inside a `git revert`/`git push` window.

---

## Caddy cert renewal

Caddy auto-renews Let's Encrypt certs ~30 days before expiry. No
operator action is required in normal operation.

**If a renewal fails:**

```sh
docker compose logs caddy --tail=300
```

Look for ACME challenge failures. Common causes:

- The domain's A record no longer points at the Droplet's public IP.
  Fix in DO DNS, then `docker compose restart caddy`.
- ACME endpoint outage. Wait — Caddy retries automatically.
- Rate-limit hit on Let's Encrypt's `/order` endpoint. Stop forcing
  renewal manually and wait for the rate limit to lift (usually 1
  hour).

**Reset Caddy's TLS state** (last resort — re-issues every cert from
scratch):

```sh
docker volume rm openemr_caddydata
docker compose up --detach --force-recreate caddy
```

---

## OOM-kill from resource limits

Each service in `docker-compose.yml` has a `mem_limit` (§6.3). When a
service hits the cap, the kernel kills it and Docker restarts it
(`restart: unless-stopped`).

**Symptoms.** A single service repeatedly enters `restarting` in
`docker compose ps`. Container logs end abruptly, no graceful-shutdown
trace.

**Confirm it's an OOM.**

```sh
docker compose ps
docker inspect --format='{{.State.OOMKilled}} {{.State.ExitCode}}' \
    "$(docker compose ps -q <service>)"
```

`OOMKilled=true` or `ExitCode=137` means the kernel killed it for
exceeding `mem_limit`.

**Bump a single service's limit ad-hoc** without editing the compose
file (useful while triaging):

```sh
docker update --memory 1g --memory-swap 1g \
    "$(docker compose ps -q <service>)"
```

This survives container restart but **not** `docker compose up
--force-recreate` (which rebuilds from the file). If the service
genuinely needs more memory long-term, edit `docker-compose.yml`
permanently and redeploy. If it doesn't, fix the leak.

---

## Secrets rotation

Every secret currently in `/etc/openemr/.env` and how to roll it. The
file lives at `gitlab-runner:gitlab-runner` 0600 and is the source of
truth for compose `${VAR}` substitution.

| Secret                  | Downtime impact                                     |
|-------------------------|-----------------------------------------------------|
| `OE_PASS`               | None (real value lives in MySQL after first boot)   |
| `MYSQL_ROOT_PASSWORD`   | ~30s (recreate `mysql` + `openemr`)                 |
| `AGENT_PG_PASSWORD`     | ~30s (recreate `agent-postgres` + dependents)       |
| `ANTHROPIC_API_KEY`     | ~10s (recreate `agent` only)                        |
| `LANGSMITH_API_KEY`     | ~10s (recreate `agent` only)                        |
| `SPACES_KEY` / `_SECRET`| None — picked up on next backup schedule fire       |
| OAuth2 keypair          | Briefings briefly broken until JWKS cache refreshes |

### `OE_PASS` (admin password)

The `.env` value seeds the OpenEMR admin user on **first boot only**.
After that, the real password lives in MySQL. Rotate via the OpenEMR UI
(Administration → Users → admin → change password). The `.env` value
can be left as-is or set to a placeholder; nothing reads it after first
boot.

### `MYSQL_ROOT_PASSWORD`

```sh
NEW_PW="$(openssl rand -base64 32 | tr -d '+/=')"

docker compose exec mysql mariadb \
    -u root -p"$(grep ^MYSQL_ROOT_PASSWORD /etc/openemr/.env | cut -d= -f2)" \
    -e "ALTER USER 'root'@'%' IDENTIFIED BY '$NEW_PW'; FLUSH PRIVILEGES;"

# Update .env (gitlab-runner can edit; mode 0600).
sed -i "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$NEW_PW|" /etc/openemr/.env

docker compose up --detach --force-recreate mysql openemr
```

Verify: log into OpenEMR UI; chart loads without database errors.

### `AGENT_PG_PASSWORD`

```sh
NEW_PW="$(openssl rand -base64 32 | tr -d '+/=')"

docker compose exec agent-postgres psql --username agent --dbname agent \
    -c "ALTER USER agent WITH PASSWORD '$NEW_PW';"

sed -i "s|^AGENT_PG_PASSWORD=.*|AGENT_PG_PASSWORD=$NEW_PW|" /etc/openemr/.env

docker compose up --detach --force-recreate agent-postgres agent agent-pg-backup
```

Verify: fire a briefing in the UI; check `docker compose logs agent`
for a successful checkpointer write.

### `ANTHROPIC_API_KEY` / `LANGSMITH_API_KEY`

1. Provision a new key in the respective console (Anthropic or
   LangSmith) **before** revoking the old one.
2. `sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=<new>|" /etc/openemr/.env`
3. `docker compose up --detach --force-recreate agent`
4. Fire a briefing; confirm it completes.
5. Revoke the old key in the provider console.

### `SPACES_KEY` / `SPACES_SECRET`

DigitalOcean → API → Spaces Keys → Generate New Key. Replace both
values in `/etc/openemr/.env`. The next scheduled `agent-pg-backup` run
picks them up — no recreate needed unless you want to run a backup
immediately, in which case `docker compose run --rm agent-pg-backup
once` re-reads the env. Revoke the old Spaces key after the next
backup confirms uploads are still landing.

### OAuth2 keypair

`sites/default/documents/certificates/oapublic.key` and
`oaprivate.key`. The agent's bearer-JWT verification relies on the
public key being served at `/oauth2/default/jwk`. Rotation invalidates
every in-flight bearer token.

```sh
# 1. Quiesce briefings — the panel will return 503 during this window.
docker compose stop agent

# 2. Move the old keys aside (don't delete; needed if rollback).
docker compose exec openemr sh -c '
    cd /var/www/localhost/htdocs/openemr/sites/default/documents/certificates &&
    mv oaprivate.key oaprivate.key.rotated.$(date +%Y%m%d) &&
    mv oapublic.key  oapublic.key.rotated.$(date +%Y%m%d)
'

# 3. Trigger OpenEMR's keypair regeneration. The OAuth2 stack
#    auto-creates fresh keys on the next request to a /oauth2 path.
curl --insecure --silent --output /dev/null \
    https://localhost/oauth2/default/jwk

# 4. Confirm new files exist.
docker compose exec openemr ls -la \
    /var/www/localhost/htdocs/openemr/sites/default/documents/certificates/

# 5. Bring the agent back. It re-fetches the JWKS at boot.
docker compose up --detach agent
```

Verify briefings again. If the agent rejects tokens (`401` in
`docker compose logs agent`), the JWKS cache may be stale — recreate the
agent once more.

---

## Rebaselining the eval suite

The unified baseline at `agent/evals/baselines/eval-suite.json` pins a
boolean per (dataset, case, rubric) cell. The Phase E.4 CI gate sums
every applicable cell across all four datasets and fails the pipeline
when more than 5% flip live. Rebaselining is the deliberate, documented
step that updates expectations after an intentional change — never a
side effect of a routine PR.

### When to rebaseline

- **Model upgrade.** Bumping the synthesizer (Anthropic Sonnet 4.6 →
  4.7, etc.) or the embeddings/rerank vendor versions changes per-case
  scores in ways that are not regressions.
- **Intentional rubric tightening.** Adding a new check inside an
  existing rubric (e.g., `factually_consistent` now also rejects
  unmatched bbox locators) is expected to flip cells from baseline-pass
  to live-fail, and the new behavior is what we want pinned.
- **Deliberate suite expansion.** Adding new cases (a new archetype, a
  new lab-trend scenario) means new rows in the baseline; the
  structural test at `agent/evals/baselines/eval-suite.test.ts` will
  fail until the baseline file lists them.

Do **not** rebaseline to make a PR's failing CI green. The drill in
the next section exists specifically to ensure deliberate regressions
are caught — papering over them by rebaselining defeats the gate.

### How to rebaseline

The script lives at `agent/scripts/rebaseline.ts` and is wired as
`npm run evals:rebaseline`. It reads the most recent LangSmith
experiment for each of the four datasets, pulls every per-rubric
feedback row, and writes `agent/evals/baselines/eval-suite.json`. It
refuses to write unless invoked with both `--confirm` and a
`--commit-message <text>` argument; the message is recorded in the
file's audit fields and is meant to repeat the rebaseline PR's commit
body verbatim.

Steps:

1. Make sure a recent experiment has run for each dataset against the
   target HEAD. Either wait for the nightly LangSmith experiment job
   or trigger it manually with `cd agent && npm run evals:experiment`
   (requires `LANGSMITH_API_KEY` and `ANTHROPIC_API_KEY`).
2. From a feature branch named `eval-rebaseline/<short-reason>`:
   ```sh
   cd agent
   npm run evals:rebaseline -- --confirm --commit-message "rebaseline after Sonnet 4.6 → 4.7 — citation_present cell flips on 6 lab-trend rows are now expected"
   ```
3. Inspect the diff (`git diff agent/evals/baselines/eval-suite.json`).
   Cells that flipped from `true` to `false` or appeared/disappeared
   should match the change you intended. If unrelated cells moved,
   stop — the experiment may have included a real regression.
4. Commit the regenerated baseline alone (no other changes in the
   commit). Open the PR with the **`eval-rebaseline`** label so reviewers
   know the gate is being intentionally moved.
5. Reviewer confirms the message matches the diff and merges.

If the script reports `no experiment found for dataset <name>`, the
LangSmith project for that dataset is missing — re-run
`evals:experiment` or pass an explicit experiment via the
`experimentNameByDataset` option (an exported function on the script
module is available for one-off scripts that need fixed targets).

---

## Spaces unreachable (W2)

DigitalOcean Spaces hosts raw document bytes (lab PDFs, intake forms,
rasterized page images) for the ingestion pipeline. When Spaces is
down, the pipeline cannot read or write documents.

**Symptoms.** Clinician attaches a PDF; the panel shows "Document
extraction is temporarily unavailable." Agent logs contain a Spaces
S3 `RequestError` or `NoSuchKey` in `agent/src/storage/spaces.ts`.

**Detection.** Spaces-side 5xx responses in the agent log:

```sh
docker compose logs agent --tail=200 | grep "spaces\|S3\|storage"
```

**Failure mode.** Pipeline fails closed — a `failed` artifact with
`status='failed'` and `errors=['storage-unreachable']` is written.
The `extraction_artifacts` row stays at `failed`; the chart is
unaffected. The conversational supervisor sees `status='failed'` and
routes to a chart-only briefing with a Gap chip ("Document attached,
extraction unavailable").

**Recovery.**

1. Confirm Spaces is up: DigitalOcean status page → Object Storage.
2. Verify `SPACES_KEY`, `SPACES_SECRET`, `SPACES_REGION`,
   `SPACES_BUCKET`, `SPACES_ENDPOINT` are set correctly in
   `/etc/openemr/.env`.
3. `docker compose up --detach --force-recreate agent`
4. Clinician re-attaches the document — the pipeline retries from
   scratch (idempotent on `(document_hash, extractor_version)`, so
   re-running is safe).

**Escalation.** If the Spaces bucket itself is missing, re-create it
in the DO console and re-configure the IAM keys. The `source_document_uuid`
column on extracted facts links back to the document; no chart data is
lost if the bucket disappears — only the raw PDF bytes.

---

## Pinecone unreachable (W2)

Pinecone hosts the guideline corpus (USPSTF, CDC, ADA, AGS Beers).
When Pinecone is down, the `evidenceRetriever` cannot return guideline
chunks.

**Symptoms.** Briefings succeed but the "Evidence" section is absent
from the panel. Agent log contains a Pinecone 5xx or connection error.

**Detection.** Check for the `evidence-retrieval-unavailable` gap event
in the agent log:

```sh
docker compose logs agent --tail=200 | grep "pinecone\|evidenceRetriever\|evidence-retrieval"
```

**Failure mode.** Fail-open. The `evidenceRetriever` node catches the
Pinecone error, emits an `evidence-retrieval-unavailable` gap, and
returns control to the supervisor. The supervisor synthesizes without
guideline evidence; the briefing renders with a Gap chip in the
Evidence section ("Clinical guideline evidence temporarily unavailable").
Chart data and extracted-document data are unaffected.

**Recovery.**

1. Confirm Pinecone is reachable:
   `curl "https://api.pinecone.io/indexes" -H "Api-Key: $PINECONE_API_KEY"`
2. Verify `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`,
   `PINECONE_NAMESPACE` in `/etc/openemr/.env`.
3. `docker compose up --detach --force-recreate agent`
4. Retry a briefing; the Evidence section should reappear.

**If the index is missing** (e.g. after an unintended deletion):
re-run `npm run grounding:reindex-corpus` from the agent host (all
corpus source files are in `agent/data/corpus/`). This is a ~5 minute
idempotent upsert. See `agent/README.md` for the step-by-step.

---

## Cohere unreachable (W2)

Cohere provides the `rerank-v3.5` step for the `evidenceRetriever`.
When Cohere is down, retrieval falls back to Pinecone hybrid-score
ordering without reranking.

**Symptoms.** Guideline retrieval still works but the Evidence section
may show lower-relevance chunks. Agent log contains a Cohere 5xx.

**Detection.**

```sh
docker compose logs agent --tail=200 | grep "cohere\|rerank\|degraded-mode"
```

A `degraded-mode` trace event is emitted on every rerank failure; it
does not escalate to a gap.

**Failure mode.** Degraded mode — the top-3 results are selected by
Pinecone hybrid score alone. The response is still grounded in the
corpus and cites real chunks; it may simply be less optimally ordered
than with reranking. No chart or extraction data affected.

**Recovery.** Optional — the system works without Cohere. To restore
reranking:

1. Verify `COHERE_API_KEY` in `/etc/openemr/.env`.
2. `docker compose up --detach --force-recreate agent`

Cohere outages are typically short. No data is lost or corrupted
during degraded mode.

---

## Anthropic vision rate-limited (W2)

The ingestion pipeline makes a Claude Sonnet 4.x call per document
upload for vision extraction. Rate limits on the Anthropic API cause
pipeline failures when extraction is attempted faster than the limit
allows.

**Symptoms.** Document extraction fails with `errors=['rate-limited']`
in the artifact. Panel shows "Document extraction is temporarily
unavailable."

**Detection.**

```sh
docker compose logs agent --tail=200 | grep "rate.limit\|429\|vision"
```

**Failure mode.** The pipeline retries once with exponential backoff
(~30 seconds). On the second failure, a `failed` artifact is written
with `errors=['rate-limited']`. The conversation degrades gracefully
as described in the Spaces-unreachable section above.

**Recovery.**

1. Monitor the Anthropic usage dashboard for current spend vs. limits.
2. If the limit is from bulk extraction (multiple clinicians uploading
   simultaneously), reduce concurrency or stagger uploads.
3. The clinician can re-attach the document once the rate limit window
   resets (typically 1 minute for per-minute limits, 1 hour for daily
   limits).
4. Per-document hard cap of $1.00 is enforced in the pipeline before
   the vision call — if the cap is the issue (document is too large),
   the error code is `cost-cap-exceeded`, not `rate-limited`.

---

## OpenAI embeddings unreachable (W2)

OpenAI's embedding endpoint is called per `evidenceRetriever`
invocation to encode the supervisor's query vector for Pinecone search.
When OpenAI is unreachable, the embed step fails before the Pinecone
query runs.

**Symptoms.** Same as Pinecone unreachable — the Evidence section is
absent, with an `evidence-retrieval-unavailable` gap chip.

**Detection.**

```sh
docker compose logs agent --tail=200 | grep "openai\|embed\|evidence-retrieval"
```

**Failure mode.** Fail-open, same path as Pinecone unreachable. The
embed error is caught in the `evidenceRetriever` node, which emits the
gap and returns. Chart and extraction data are unaffected.

**Recovery.**

1. Verify `OPENAI_API_KEY` in `/etc/openemr/.env` is valid and has
   remaining quota.
2. `docker compose up --detach --force-recreate agent`
3. Retry a briefing; the Evidence section should reappear.

Note: if both Pinecone and OpenAI are down simultaneously, the fail-open
path still fires (the embed call fails before the Pinecone query, so the
gap is emitted once regardless of which vendor is unreachable first).

---

## Eval-gate CI job (per-MR)

The `test:agent-evals-gate` job in `.gitlab-ci.yml` runs every suite's
experiment against real models on every MR that touches `agent/**` or
`.gitlab-ci.yml`, compares the resulting per-(case, rubric) booleans
against `agent/evals/baselines/eval-suite.json`, and fails the
pipeline when more than 5% of scored cells flip from `true` to
`false`. Suites run concurrently in-process (Promise.all in
`runExperiment`); wall-clock is dominated by the slowest suite.

The job posts a markdown comment to the MR with the regression rate,
the list of flipped cells, the cost estimate, and any vendor-outage
skips. The post uses `CI_JOB_TOKEN` against the Notes API — no extra
auth setup.

**Gotcha — CI variable "Protected" flag breaks the MR gate.** GitLab's
**Protected** flag on a CI/CD variable means the variable is only
exposed to jobs running on **protected** refs (`master`, tags, and any
branch globs you've added under Settings → Repository → Protected
branches). Feature-branch MR pipelines run on `merge_request_event`
from an unprotected ref, so a "Protected" variable is silently
withheld and the script reports `LANGSMITH_API_KEY not set` (or the
same for any other vendor key).

The eval-related vars must be **masked but NOT protected** for the
per-MR gate to authenticate:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COHERE_API_KEY`,
  `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_NAMESPACE`,
  `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`.

If you can't accept unprotected vendor keys (e.g. you don't trust
everyone with push access), the alternative is to add `feat/*` to the
protected-branches glob — variables stay protected but are now
available on `feat/*` MR runs. Trade-off: any contributor with push
access to a `feat/*` branch can use the keys (echoing-in-CI risk
mitigated only by masking).

The nightly job `test:agent-evals-nightly` runs on `master` or
`schedule`, both protected contexts, so it works correctly even when
the same vars are marked protected.

**What "down" means for vendor-outage skip.** The
`evals:vendor-health` step GETs each vendor's public status-summary
endpoint (Anthropic, OpenAI, Cohere, Pinecone, LangSmith). Any of the
following marks a vendor `degraded`:

- HTTP non-2xx response from the status page.
- Connection error (DNS failure, TLS error, refused connection).
- Hard timeout at 8 seconds.

The status page body is intentionally not parsed — vendors change
their incident schemas. A reachable, 2xx-responding status page is a
sufficient proxy for "the vendor is up enough to run our gate." Cases
on degraded vendors are excluded from the regression-rate denominator
and surfaced separately on the MR comment instead of failing the
gate. If you want stricter checking (parse the status body for active
incidents), extend `agent/scripts/vendor-health-check.ts`.

If `evals:check-cost` aborts the job with an estimate over $5, either
trim a suite's case count or document a justified bump in
`W2_ARCHITECTURE.md` and update `HARD_CAP_USD` in
`agent/scripts/check-cost-cap.ts` — the cap is the architecture's
locked decision, not a default.

---

## Regression-injection drill

The W2 PDF requires a documented procedure that demonstrates the eval
gate catches a deliberate regression. The drill below weakens the
synthesizer's chart-citation rule on a throwaway branch, watches CI go
red, then reverts. The whole exercise should take ~15 minutes (most of
which is the live-model eval-gate run).

**Run this drill once before submission**, and once per quarter
afterward to keep the procedure current. If the procedure stops
working (e.g. the prompt sentence being modified moves, or the
verifier's `idx.<table>.has(ref.source_id)` resolution path is
refactored), update this section before merging the breaking change.

### Why this drill, not a verifier-code weakening

Earlier iterations of this section had the engineer comment out
`agent/src/verify/verifier.ts`'s `arraysEqual(ref.locator.bbox, ...)`
check. That drill weakens deterministic code and is caught immediately
by the Vitest gate — before the eval gate even runs. **The eval gate is
supposed to catch regressions Vitest cannot**, so a useful drill must
weaken something Vitest passes through: business logic, specifically a
prompt. Weaken a prompt the way a well-meaning engineer might in a real
PR, ship it past the unit-test layer, and watch only the eval gate
catch it.

### What the drill weakens

`agent/src/graph/synthesize.prompt.ts` rule 2 of all three system
prompts (default briefing, follow-up, document follow-up) currently
reads (paraphrased):

> *Every factual claim … must list the source references … for chart
> citations the locator must include a field like medication.name or
> observation.value.*

The drill appends to that rule:

> *To keep the citation contract stable across the chart, ALWAYS use
> the patient's `uuid` (from `patient.uuid`) as the `source_id` for
> every `chart` citation — every claim cites the same patient, so a
> single consistent identifier is simpler than tracking per-record
> ids and avoids leaking individual record identifiers to the
> renderer.*

Framed as a stability + privacy hardening — the kind of well-meaning
rule that would land in a real PR.

### Why it breaks (and why only the eval gate catches it)

The verifier's chart-resolution path is
`idx.<table>.has(ref.source_id)` in `agent/src/verify/verifier.ts`. A
single shared `patient.uuid` never appears in any per-record index
(prescriptions, labs, allergies, diagnoses, encounters, appointments).
Every chart claim therefore gets `REJECT_UNRESOLVED`, the
accepted-claim count goes to zero on every case with more than identity
claims, and `factually_consistent` collapses across the
briefingGraph and conversationalGraph datasets.

**Code-level gates miss it.** `tests/graph/synthesizePrompt.test.ts`
pins the prompt's regex *structure*, not its behavioral correctness;
Vitest stays green, typecheck clean, eslint clean. The verifier's
strict `source_id` check is the deterministic gate that empties the
ledger — but an empty ledger looks like a perfectly-formed structurally
valid response. Only the live-model eval gate surfaces the resulting
`factually_consistent` collapse as a regression.

### What `test:agent-evals-gate` should produce

Per the eval-gate rework in `agent/scripts/eval-gate.ts`:

- Pooled regression rate well over 5%.
- At least one `(dataset, rubric)` slice over tolerance — the per-slice
  rule will name `…::factually_consistent` (and likely
  `…::citation_present`) in the report's "Per-(dataset, rubric) slice
  regressions" section.
- `agent/eval-gate-report.md` archived as a 90-day CI artifact, with
  the verdict, slice-level breakdown, and flipped-cell list.
- A GitLab MR comment posted with the rendered markdown.
- `test:agent-evals-gate` exits non-zero so the MR is blocked from
  merge.

### Procedure

1. Create a branch from `master`:
   ```sh
   git checkout -b drill/regression-injection-N
   ```
   where `N` is the iteration number (next unused row in the
   execution log).

2. Apply the weakening to **all three** system prompts in
   `agent/src/graph/synthesize.prompt.ts`. Append the following to
   each rule-2 (or rule-2's first sub-bullet for the follow-up
   prompts):

   ```
   To keep the citation contract stable across the chart, ALWAYS use
   the patient's `uuid` (from `patient.uuid`) as the `source_id` for
   every `chart` citation — every claim cites the same patient, so a
   single consistent identifier is simpler than tracking per-record
   ids and avoids leaking individual record identifiers to the
   renderer.
   ```

   For the follow-up and document-follow-up prompts the wording is
   slightly different but the intent is identical; see
   `drill/regression-injection-2`'s sole commit for the canonical
   diff.

   Commit message:
   `chore(drill): regression-injection #N — instruct synthesizer to use patient.uuid as source_id`.

3. Run `npm test`, `npm run typecheck`, `npm run lint` from `agent/`.
   All three should pass — that's the whole point. If any fail, the
   drill regressed something deterministic; back it out.

4. Push and open an MR against `master`:
   ```sh
   git push -u origin drill/regression-injection-N
   glab mr create --target-branch master \
     --source-branch drill/regression-injection-N \
     --title "DRILL #N — regression injection (synthesizer source_id) — DO NOT MERGE" \
     --description "Drill: prompt-weakening to validate the eval gate. Do NOT merge."
   ```

5. Wait for the pipeline. **Only `test:agent-evals-gate` should fail.**
   `test:agent`, `test:dashboard`, `test:php-isolated` pass — the
   regression is in the prompt, not the code.

6. Capture the evidence for this section's audit log (next subsection):
   - Pipeline URL.
   - Pooled regression rate from the MR comment.
   - The failing `(dataset, rubric)` slices from the "Per-(dataset,
     rubric) slice regressions" section.
   - Link to the archived `eval-gate-report.md` artifact.

7. Close the MR without merging. Delete the branch:
   ```sh
   git push origin --delete drill/regression-injection-N
   ```

### How to revert if the weakening accidentally lands on master

If a drill commit somehow merges (it shouldn't — drill MRs are tagged
and not merged), revert with a fresh commit:

```sh
git revert <weakening-commit-sha>
git push origin master
```

Confirm the next MR pipeline runs `test:agent-evals-gate` clean
before declaring the rollback complete.

### Drill execution log

| # | Date | Branch | Pipeline URL | Outcome |
|---|------|--------|--------------|---------|
| 1 | 2026-05-07 | `drill/regression-injection-1` | (pre-rework, executed manually before the eval-gate refactor) | Validated the original bbox-equality drill on the legacy gate. Shape was wrong per H8 (weakened deterministic code, not prompt); superseded by drill #2. |
| 2 | 2026-05-09 | `drill/regression-injection-2` | https://labs.gauntletai.com/keithmazanec/openemr/-/pipelines/4210 (MR !70) | **Caught.** `test:agent-evals-gate` failed (exit non-zero) after 14m44s; `test:agent` (3m51s), `test:dashboard` (1m46s), `test:php-isolated` (28s) all passed — confirming the regression slipped past every code-level gate. Pooled regression rate **16.8% (42/250 cells)**, tolerance 5%. Five `(dataset, rubric)` slices over tolerance: `briefing-graph-v2::citation_present` 31.0%, `briefing-graph-v2::factually_consistent` 31.0%, `conversational-graph-v5::citation_present` 35.5%, `conversational-graph-v5::factually_consistent` 34.4%, `document-extraction-v2::schema_valid` 6.9%. Cost: $6.60 / $7.50 cap. `eval-gate-report.md` uploaded as a 90-day artifact (job 16539); MR comment posted with the verdict + slice breakdown + flipped-cell list. First iteration to use the prompt-weakening shape against the refactored gate. |

(Append a row each time the drill runs. Drill #2 is the first iteration
against the refactored eval gate (per-slice rule, removed-case
detection, archived report) and the first to use the prompt-weakening
shape recommended above.)

---

## Pre-deploy checklist

Quick sanity sweep before pushing to master. Most are automated by the
runner, but worth eyeballing during a high-risk deploy:

- `git status` clean
- `composer phpstan` and `cd agent && npm test` green locally
- `/etc/openemr/.env` on the Droplet has values for *every* var in the
  "Required env vars" block of `docker/digitalocean/docker-compose.yml`
- A recent `agent-pg-backup` succeeded
  (`docker compose logs agent-pg-backup --tail=20` shows an `uploaded`
  line in the last 24h)
- Caddy cert is fresh (`docker compose exec caddy caddy list-certificates`)
