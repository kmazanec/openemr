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
verifier's bbox-equality check on a throwaway branch, watches CI go
red, then reverts. The whole exercise should take ~10 minutes.

**Run this drill once before submission**, and once per quarter
afterward to keep the procedure current. If the procedure stops
working (e.g. the line being weakened moves, or the test asserting
the invariant gets renamed), update this section before merging the
breaking change.

### What the drill weakens

`agent/src/verify/verifier.ts` has a bbox-equality check on every
`extracted_document` claim's locator:

```ts
if (!arraysEqual(ref.locator.bbox, snippet.bbox)) {
    return { ok: false, reason: REJECT_CONTENT };
}
```

(See `agent/src/verify/verifier.ts:781-782` at the time of writing —
search for `arraysEqual(ref.locator.bbox` if the line numbers have
moved.)

This check ensures a synthesizer can't fabricate a citation by
combining a real document id with an arbitrary bbox — the bbox must
match the snippet the retriever returned. Removing it lets fabricated
bboxes through, which is exactly the kind of regression the gate
needs to catch.

### Two failure signals you should see

1. **Vitest gate (deterministic, fast).** The case
   `agent/evals/cases/conversational-graph/verification/verification.test.ts`
   `"extracted-document claim with a fabricated bbox is rejected even
   when the artifact id resolves"` flips red immediately when the
   weakening lands. This is the proof that the weakening took effect.
2. **CI eval gate (real-model, slow).** The live experiments now
   accept `extracted_document` claims that previously rejected on
   bbox mismatch, which flips multiple `factually_consistent` and
   `citation_present` cells across the conversational-graph and
   end-to-end datasets. The flipped-cell count exceeds 5% of scored
   cells, so `npm run evals:gate` exits non-zero and the
   `test:agent-evals-gate` job fails. This is the proof that the
   *gate* caught the regression.

### Procedure

1. Create a branch from `master`:
   ```sh
   git checkout -b drill/regression-injection-N
   ```
   where `N` is the iteration number (1 for the first drill).

2. Apply the weakening. Comment out lines 781-782 of
   `agent/src/verify/verifier.ts`:
   ```ts
   // DRILL: bbox-equality check disabled to validate eval gate
   // if (!arraysEqual(ref.locator.bbox, snippet.bbox)) {
   //     return { ok: false, reason: REJECT_CONTENT };
   // }
   ```
   Make a single commit with message
   `chore(drill): regression-injection #N — disable bbox equality`.

3. Push and open an MR against `master`:
   ```sh
   git push -u origin drill/regression-injection-N
   glab mr create --title "DRILL #N — regression injection" \
     --description "Drill: bbox-equality weakening to validate the eval gate. Do NOT merge."
   ```
   Tag the MR with the `drill` label so reviewers know not to merge.

4. Wait for the pipeline. Two jobs should fail:
   - `test:agent` — Vitest gate flips on the bbox case.
   - `test:agent-evals-gate` — eval gate flips multiple
     `factually_consistent` / `citation_present` cells, regression
     rate exceeds 5%.

5. Capture the evidence for this section's audit log:
   - Pipeline URL.
   - The Vitest failure output (the "fabricated bbox" assertion).
   - The eval gate's MR comment with the flipped-cell list.

6. Close the MR without merging. Delete the branch:
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
| 1 | _pending_ | _pending_ | _pending_ | _pending_ |

(Append a row each time the drill runs. The first row stays `pending`
until the engineer who runs the drill before W2 submission fills it
in.)

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
