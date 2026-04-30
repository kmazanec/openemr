# Pre-Search: Clinical Co-Pilot

This document captures the design decisions made before writing code, along with the reasoning behind each. It serves as the source of truth for architectural intent — every decision in `ARCHITECTURE.md` should trace back to a constraint or rationale documented here.

---

## Phase 1: Constraints

### 1. Domain Selection

**Domain:** Healthcare — specifically clinical decision support embedded in OpenEMR.

**Primary user:** Primary care physician with a 20-patient scheduled day.

**Core moment:** The 90-second window between patient rooms, when the physician needs to recall who they're seeing, why, what changed since the last visit, and what matters today.

**Use cases supported:**
- Pre-visit patient briefing (the central use case)
- Surfacing changes since last visit (new labs, med changes, recent encounters)
- Current medication list with dosages
- Active allergies and known interactions
- Today's schedule context — knowing which patients are coming and when

**Verification requirements:**
- Every medication claim must cite the exact source record
- Every lab value must include the source date and reference range
- Allergies must always be surfaced, never omitted, regardless of query
- The agent must report only what is in the record — no inference, no extrapolation

**Data sources:** All from OpenEMR's own database — patient demographics, encounter notes, medication lists, lab results, allergies, schedule.

**Reasoning:** The case study makes the user the foundation of every other decision. A primary care physician with a scheduled day is the most concrete, most defensible user — they have predictable workflows, predictable data needs, and a clear "moment of need" the agent can serve. ED residents and hospitalists are valid alternatives, but their workflows are more chaotic, which makes scoping harder in week one. Choosing the most constrained user produces the cleanest architecture.

---

### 2. Scale & Performance

**Target response time:** 3-7 seconds with a loading state. Under 3 seconds is ideal but unrealistic when synthesizing across multiple data sources; over 10 seconds is unusable in a 90-second window.

**Concurrent users:** 5-15 — the size of a family practice with physicians, nurses, support staff, and physicians who float between clinic and hospital settings.

**Cost constraints:** Per-query LLM cost must be tracked from day one for the production cost analysis deliverable. The architecture must support cost projection at 100 / 1K / 10K / 100K users.

**Reasoning:** The case study explicitly asks how the system would scale to a 500-bed hospital with 300 concurrent clinical users. Designing for one user and retrofitting RBAC and multi-tenancy later is a known anti-pattern — the architecture has to support a small team from day one even though the MVP demo only exercises one. Scoping to a family practice (rather than a single physician or a full hospital) gives a realistic, defensible middle ground that exercises every important architectural concern without overbuilding.

---

### 3. Reliability Requirements

**Cost of a wrong answer:** Patient harm. A hallucinated dosage, missed allergy, or fabricated lab value can directly cause clinical errors. The standard is not "usually right" — it is "never confidently wrong."

**Verification policy (non-negotiable):**
- Only source-attributed claims reach the user
- Unverified claims are stripped from the response
- The agent acknowledges that unverified information existed without exposing it ("I found additional information I couldn't verify against a source record")
- All unverified claims are logged with full detail for debugging and analytics
- Missing data is explicitly surfaced, not silently omitted

**Hard clinical rules — fail closed in all cases:**
- Allergies must always be surfaced when relevant
- Drug interactions must always be flagged when present
- Dosage threshold violations must always be flagged

**Human-in-the-loop:** The physician is always the decision-maker. The agent advises, never prescribes. There is no autonomous action — every output is read by the physician before being acted on.

**Behavior on uncertainty:** Say what was found, explicitly flag what's missing. Never silently omit, never guess.

**Behavior on ambiguity:** Ask one clarifying question before proceeding. Don't reject the query, don't guess at intent.

**Reasoning:** The case study is explicit that "a confidently stated hallucination in a clinical setting doesn't just damage trust — it can directly harm a patient." The verification policy follows directly from this. The rule "only source-attributed claims reach the user" is the strictest defensible position — strict enough to be trustworthy, transparent enough to be useful. Logging unverified claims preserves debuggability without compromising user trust. The three hard clinical stops are the safety floor — anything that touches dosing, drug interactions, or allergies must be verified before reaching the user, because these are the categories where errors most directly harm patients.

---

### 4. Team & Skill Constraints

**Team size:** Solo developer.

**Timeline:** One week to MVP, three weeks total.

**Framework familiarity:** No prior LangChain or LangGraph experience.

**Eval framework experience:** Familiar with standard unit testing, no prior LLM eval framework experience.

**Stack preference:** Integrate into OpenEMR's UI as seamlessly as possible. Use languages already in the project where reasonable; deviate only when well-justified (e.g. no mature PHP option).

**Reasoning:** Acknowledging the learning curve up front prevents over-ambitious framework choices. The decision to use LangGraph despite no prior experience is deliberate — its explicit state model maps well to clinical workflows and produces the auditability the case study demands — but it shapes the schedule. Evals being new territory means the eval suite has to be built deliberately, not assumed.

---

## Phase 2: Architecture

### 5. Agent Framework

**Framework:** LangGraph.js

**Architecture:** Two-agent pipeline — a retrieval/synthesis agent and a verification agent.

**State management:** LangGraph's built-in state graph. Conversation state, retrieved data, source tags, and verification results all live in the graph state.

**Reasoning:** A custom agent loop in TypeScript would be simpler and faster to build, but LangGraph's explicit node/edge structure gives a clear, auditable trace of what the agent did and in what order — exactly what a clinical setting demands. The learning curve is real, but the structure pays off in observability and architecture defense.

The two-agent split is a deliberate separation of concerns. The retrieval agent's job is to gather and synthesize patient data with source tags. The verification agent's job is to enforce the verification policy — strip unverified claims, run hard clinical rule checks, log unverified material. Splitting these into separate agents makes each one simpler, makes the verification step impossible to skip, and maps cleanly to the case study's requirement that verification be a deliberate, separate step in the architecture.

A multi-agent orchestration system (router agent, multiple retrievers, etc.) was rejected as overbuilt for the MVP scope.

---

### 6. LLM Selection

**Model:** Claude Sonnet 4 for both the retrieval agent and the verification agent.

**Reasoning:** Sonnet 4 has strong tool use, a large context window for dense EHR records, and excellent instruction-following — the last is particularly important for staying within source data and not hallucinating. Using the same model for both agents keeps the system simple and consistent for MVP.

A future cost optimization is to swap the verification agent to Haiku, which is cheaper and faster. This optimization is deferred until evals demonstrate that quality does not degrade. Documenting this as a future optimization (rather than building it now) is itself a defensible production cost analysis story.

---

### 7. Tool Design

**Tools (5 total — held to the discipline of "fewer than 5 skills per agent"):**

1. `get_patient_summary` — demographics, active diagnoses, allergies
2. `get_recent_labs` — labs since last visit with reference ranges and abnormal flags
3. `get_medications` — current med list with dosages
4. `get_recent_encounters` — last 1-3 visit notes
5. `get_todays_schedule` — patients on today's schedule for the authenticated physician

**Data source:** OpenEMR's existing REST/FHIR API from day one. The agent never queries MySQL directly — every tool is an HTTP wrapper over an OpenEMR endpoint, which keeps RBAC, audit logging, and schema concerns in OpenEMR where they already live. The LLM produces tool-call JSON with typed parameters (patient UUIDs, date ranges); it never produces SQL, and no LLM output is ever interpolated into a query.

**Endpoint mapping** (verified against OpenEMR's existing API surface — see section 18):

| Tool | Endpoint |
|---|---|
| `get_patient_summary` | `GET /fhir/Patient/{id}` + `Condition?patient={id}&clinical-status=active` + `AllergyIntolerance?patient={id}` |
| `get_recent_labs` | `GET /fhir/Observation?patient={id}&category=laboratory&date=ge{date}` |
| `get_medications` | `GET /fhir/MedicationRequest?patient={id}&status=active` |
| `get_recent_encounters` | `GET /fhir/Encounter?patient={id}&date=ge{date}` |
| `get_todays_schedule` | `GET /fhir/Appointment?practitioner={fhirUser}&date={today}` — OpenEMR's existing FHIR Appointment endpoint does not currently filter by practitioner; we extend it to accept the standard FHIR `practitioner` search parameter. This is a small PHP change scoped to that one controller and stays inside the FHIR spec rather than introducing a custom non-standard endpoint. Revisitable if the change turns out larger than expected — fallback would be a custom REST endpoint at `/api/provider/{uuid}/schedule`, documented as a deliberate deviation. |

**Tool error contract:**
- Every tool retries once on transient failure
- On second failure, returns a structured error indicating what failed and why
- Safety-critical tools (`get_medications`, `get_patient_summary` for allergies) fail closed — agent surfaces an explicit error to the physician
- Non-critical tools (`get_recent_labs`, `get_recent_encounters`, `get_todays_schedule`) fail open — agent returns partial data with an explicit flag
- All failures logged regardless

**Reasoning:** Five tools is enough to serve the pre-visit briefing use case without over-scoping. Each tool maps directly to a use case in the user definition — there are no tools that exist "just in case."

Going through OpenEMR's API rather than the database directly means the demo is grounded in OpenEMR's actual data model *and* its actual access-control boundary. Every tool call traverses the same authorization code that runs when a physician opens a chart in the UI — RBAC is enforced once, in OpenEMR, and the agent has no privileges of its own. This is also a stronger architecture-defense story than direct DB access: the agent can only see what the requesting physician could see by clicking around the EHR.

The tiered failure behavior (safety-critical fail closed, others fail open) is a clinical judgment decision encoded in architecture. Allergies and medications cannot be missing without the physician knowing — that's a safety floor. Labs and encounter notes are informational; partial data with a clear flag is more useful than no data at all.

---

### 8. Observability Strategy

**Platform:** LangSmith.

**Metrics tracked:**
- Latency per tool call
- Total response time
- Token count per query
- Cost per query
- Verification pass/fail rate
- Unverified claim frequency
- Per-physician usage
- Queries per patient

**Reasoning:** LangSmith is the most enterprise-recognized observability platform in the LangChain ecosystem and the natural fit alongside LangGraph.js. Langfuse is gaining ground but is more common in startups and self-hosted environments; for a project framed around a hospital CTO making a procurement decision, LangSmith is the easier defense.

The per-physician and per-patient metrics are deliberately included for the production cost analysis deliverable. Cost projection at scale isn't just "cost-per-token times users" — it's a function of how many queries each physician makes, how many of those touch the same patient, and where caching opportunities exist. These metrics provide the data to make a real projection rather than a back-of-envelope calculation.

Verification pass/fail rate and unverified claim frequency are the leading indicators of agent quality. If unverified claims start increasing, something has changed in the retrieval agent or the underlying data — observability catches that before evals do.

---

### 9. Eval Approach

**Framework:** Vitest.

**Execution:** Fully automated, runs in GitLab CI/CD on every merge request and on a nightly schedule.

**Three tiers of eval cases:**
1. Happy path — does the agent return correct, source-attributed information for normal patient queries?
2. Failure cases — missing data, tool failures, unauthorized access attempts
3. Adversarial cases — prompt injection attempts, cross-patient data leakage attempts, attempts to extract data the requester is not authorized to see

**Ground truth source:** OpenEMR's sample patient data. Every test case has a known correct answer derived from inspecting the actual records.

**Pass/fail criteria:**
- Factual correctness against source records
- All claims source-attributed
- No cross-patient data leakage
- No prompt injection vulnerability
- Graceful failure on missing or partial data

**Reasoning:** The case study explicitly says "a strong eval suite does more than confirm happy paths. It surfaces failure modes, regression risks, and the edge cases that matter in clinical settings." The three-tier structure is a direct response to that requirement.

Adversarial cases are the most important tier and the one most candidates skip. They are also the cases the case study specifically calls out: "inputs that attempt to extract information the requester is not authorized to see." Building these from week one establishes the precedent that security is a tested property, not an assumed one.

Fully automated execution in CI is the only way evals actually run consistently. Manual execution before submission deadlines fails because it always slips. Nightly runs catch regressions introduced by external changes (model updates, dependency changes, data drift).

---

### 10. Verification Design

**Approach:** Source tagging at retrieval time (Option C).

The retrieval agent is required to tag every claim it makes with the exact source record ID it came from (e.g. `[lab_result:1234]` or `[medication:567]`). The verification agent then performs a structured check: does the cited record actually support the claim?

**Two alternatives considered and rejected:**

- **Post-processing gate (Option A):** Verification agent reads the natural-language response and tries to trace claims back to records. Rejected because reverse-mapping fuzzy claims to records is harder, slower, and less reliable than checking explicit tags.

- **Independent re-query (Option B):** Verification agent independently queries the DB for the same data and compares. Rejected because it doubles DB calls and adds latency that breaks the 3-7 second target.

**Verification flow:**
1. Retrieval agent produces a response with inline source tags for every factual claim
2. Verification agent walks each tagged claim and confirms the cited record supports it
3. Hard clinical rule checks (allergies, drug interactions, dosage thresholds) run as mandatory passes
4. Unverified claims are stripped from the response
5. All unverified claims are logged with full detail
6. The user-facing response includes the verified claims with citations the physician can tap to see the original record

**Confidence thresholds:** A claim is verified or it is not — there is no probabilistic confidence threshold. This is deliberate: in a clinical setting, "70% confident" is worse than "verified" or "unverified, hidden."

**Escalation triggers:** Hard clinical rule failures are not silently corrected. If the verification agent finds an allergy or interaction the retrieval agent missed, the response is held and a structured warning is surfaced to the physician.

**Reasoning:** Source tagging is the fastest of the three options and produces the best audit trail. It also generates the citation UI feature for free — every claim in the response can link directly to its source record, which is exactly what a hospital CTO would expect to see. The architecture maps cleanly onto the case study requirement that "every claim must be traceable back to a source."

The decision to make verification binary rather than probabilistic is a clinical-domain decision. Probabilistic confidence is appropriate when users can reason about uncertainty. In a 90-second pre-visit window, a physician cannot meaningfully act on a "70% confidence" label — the response either supports their decision or it doesn't. Hiding unverified material and acknowledging its existence is more useful than exposing low-confidence claims with disclaimers.

---

## Phase 3: Refinement

### 11. Failure Mode Analysis

**Tool failures:** Retry once, then return structured error. Safety-critical tools fail closed; non-critical tools fail open with explicit flag.

**Ambiguous queries:** Agent asks one clarifying question before proceeding rather than guessing or rejecting outright.

**Rate limiting:** Same tiered logic as tool failure. Anthropic API rate limit on a safety-critical path fails closed; on a non-critical path the agent returns whatever was retrieved before the limit, flagged as partial.

**Missing patient records:** Surface what's available with explicit gaps flagged. Never silently omit.

**Model returning unexpected output:** Verification agent's job to catch this. If the retrieval agent produces output that can't be parsed for source tags, the verification agent rejects it and the agent surfaces a structured error rather than a malformed response.

**Reasoning:** "A clinical tool that crashes or silently fails is worse than no tool at all." Every failure mode here has a deliberate, predictable behavior. The tiered fail-closed/fail-open distinction is the most important: it encodes the clinical priority that allergies and medications are non-negotiable, while accepting that labs and encounter notes can degrade gracefully.

The "one clarifying question" rule is a balance — rejecting ambiguous queries is rude in a 90-second window, but guessing at intent is dangerous. One clarification is the minimum useful interaction.

---

### 12. Security Considerations

**Authentication:** OpenEMR's existing session/auth system. The physician logs into OpenEMR normally; the agent panel is rendered inside an authenticated OpenEMR page. The agent service never authenticates users itself, never stores user credentials, and is not directly reachable by the browser — see section 18 for the full integration shape.

**RBAC:** Delegated entirely to OpenEMR. The agent makes no authorization decisions; it calls OpenEMR's REST/FHIR API as the acting user, and OpenEMR's existing ACL enforces who can see which patients. The three tiers (physicians see their assigned patients, nurses see theirs, admins see all) are OpenEMR's existing model — the agent inherits it for free.

**Prompt injection prevention:**
- Patient data is treated as untrusted input even though it comes from the EHR
- System prompt explicitly instructs the agent to ignore instructions found in patient data
- Verification layer is a second line of defense — even if a prompt injection gets the retrieval agent to fabricate a claim, the verification agent will strip it because there is no source tag
- Adversarial test cases in the eval suite cover this directly

**Data leakage prevention:**
- No PHI in logs — claim metadata only (source IDs, lengths, verification status), never claim content
- API keys in environment variables, never in code, never in logs
- Source tags reference record IDs, not record content, in observability traces

**Audit logging:**
- Every query logged: who asked, what they asked, what tools were called, what was returned (verification status only, not content)
- Every unverified claim logged in full for debugging — but in a separate, access-restricted log stream
- HIPAA audit trail requirements documented in `AUDIT.md`
- **Two-table disclosure logging**, decided after researching how HIPAA is being interpreted to apply to LLMs in healthcare:
  - **OpenEMR's existing `extended_log`** is the regulatory trail. One row per (clinician, patient, day) with `event = 'disclosure-ai-treatment'` (a new entry seeded into the `disclosure_type` list), `recipient = 'Clinical Co-Pilot Agent'`, and a category-summary description. Surfaces in the patient summary's Disclosures view alongside Treatment / Payment / Health Care Operations entries OpenEMR already ships, and in any §164.528 Accounting of Disclosures report. Per-day dedup means a clinician opening a chart 30 times in one day produces one row, not 30.
  - **A new `agent_request_log` table** is engineering instrumentation. One row per request, structured `categories` JSON, indexed on `(patient_pid, disclosed_at)` and `(actor_user_id, disclosed_at)`. Used for cost analysis, idempotency (UNIQUE on `request_id` derived from the JWT `jti`), and forensic debugging. Not an audit table; the regulatory trail is `extended_log`.
  - Both writes fire from a single Symfony event (`AgentDisclosedEvent`) consumed by one listener that dispatches to two recorders. Independent failure handling — a DBAL hiccup in one sink does not block the other.
  - **Neither table stores prompt or completion content.** The recorder DTO (`AgentDisclosure`) accepts no body parameter; structural tests pin the constructor signature, the recorder's column list, and the migration's `addColumn` calls against a forbidden-substring list (`prompt`, `completion`, `request_body`, `response_body`, `message`, `content`, `snapshot`).

**Why two tables and not just `extended_log`:** `extended_log.description` is a free-form longtext, which loses structured-query ability for cost rollups and eval reproduction. The split keeps each table fit for its readers — compliance officers get one legible row per patient-day in the existing UI; engineers get per-request structured rows.

**HIPAA classification in plain English (full analysis lives in the module's help panel — Modules → Manage Modules → ?):** Clinician-invoked AI on the current patient's own chart for the current encounter, with the LLM vendor under a BAA, is a *use for treatment* under 45 CFR §164.506(c). The transmission to the BA is excluded from §164.528 accounting by §164.528(a)(1)(i). We log to `extended_log` anyway because OpenEMR's interpretive stance — its `disclosure_type` list ships pre-populated with `disclosure-treatment` / `-payment` / `-healthcareoperations` — is that even TPO disclosures should be patient-visible. Aligning with that posture is more defensible than quietly omitting AI use from the patient's accounting report.

**BAA implications:** The case study notes to "act as if you have a signed Business Associate Agreement with all LLM providers that no data will be used for training purposes." This shapes the architecture by allowing PHI to be sent to Anthropic in tool results, but in production the BAA must actually exist and the architecture must support providers that don't have one (e.g. by allowing PHI redaction at the tool layer).

**Reasoning:** Piggybacking on OpenEMR's auth is the right call because it means the agent inherits the same trust boundary the physician already authenticated through — there is one authentication system, one session, one audit trail. Building a separate auth layer doubles the attack surface and complicates the HIPAA story.

The verification layer doubling as a prompt injection defense is a side effect of the source tagging design that's worth calling out explicitly. A prompt injection that successfully manipulates the retrieval agent still has to produce a claim with a valid source tag that survives verification — which is significantly harder than just manipulating the retrieval agent's output.

---

### 13. Testing Strategy

**Test framework:** Vitest.

**CI:** GitLab CI/CD pipeline — runs on every merge request and on a nightly schedule.

**Test layers:**
- Unit tests per tool — does each tool query the right data, enforce RBAC, handle errors per the contract?
- Integration tests for agent flows — does the full retrieval-to-verification pipeline produce the expected output for known patient queries?
- Eval suite — three-tier (happy path, failure cases, adversarial) as defined in section 9
- Regression tests — every bug found becomes a permanent test case

**Reasoning:** Vitest is the modern default for TypeScript projects, fast, and has good ESM support. GitLab CI/CD runs the same patterns as GitHub Actions — pipelines on MRs and on schedules — just in a different YAML syntax. The combination of unit tests for tool correctness, integration tests for agent flows, and evals for end-to-end quality covers the three failure surfaces independently.

The regression test policy ("every bug becomes a permanent test case") is the eval suite's growth strategy. By the end of week three, the eval suite should reflect every failure mode encountered during development.

---

### 14. Open Source Planning

**License:** GPL-3.0, inherited from OpenEMR. All additions must comply.

**Visibility:** Private repo on internal GitLab, shared org-wide. License-aware in case of future public release.

**Documentation:** README covers setup, deployment, and architecture overview. ARCHITECTURE.md covers the full design. AUDIT.md covers the OpenEMR baseline audit. USERS.md covers the target user and use cases.

**Reasoning:** GPL-3.0 means any future public deployment requires source availability. Documenting this constraint up front prevents accidental licensing debt — e.g. someone adding a proprietary dependency that can't be GPL-3.0-compatible. Keeping the repo private now while remaining license-aware is the lowest-cost posture.

---

### 15. Deployment & Operations

**Hosting:** A single DigitalOcean Droplet (`s-2vcpu-2gb`, Ubuntu 24.04) running three containers via docker-compose:
- **mysql** — MariaDB. Internal Docker network only.
- **openemr** — Upstream `openemr/openemr:flex` image, with this repo bind-mounted at `/var/www/localhost/htdocs/openemr/` so application code from this repo is what runs (not whatever was baked into the image). Internal Docker network only — Caddy fronts it.
- **caddy** — Reverse proxy on the public 80/443. Auto-fetches and renews a Let's Encrypt cert for `emr.biograph.dev`. Forwards to OpenEMR's internal port 443 over Docker's private network.

The compose stack lives at `docker/digitalocean/docker-compose.yml`; reverse-proxy config at `docker/digitalocean/Caddyfile`; provisioning logic at `infra/bootstrap-do.sh` and `infra/cloud-init.sh.template`.

**Environment:** Just one (production) for now, on `emr.biograph.dev`. Adding a `dev` environment on `emr-dev.biograph.dev` is a deferred follow-up — either a second Droplet (clean isolation) or a second compose project on the same Droplet (cheaper).

**Why DigitalOcean over alternatives — including the original Railway plan:**
- **Railway was attempted first and abandoned.** Railway's edge proxy speaks plain HTTP to upstream containers and could not reach the OpenEMR container in our configuration despite extensive debugging (the OpenEMR maintainer team has explicitly noted the flex image is not designed for behind-a-proxy deployments). After several days of working around Railway-specific constraints — port-binding quirks, IPv6/IPv4 dual-stack issues, conflicting Apache directives between the upstream image and our overlay — we moved to a host where we control the network end-to-end.
- **Fly.io** has no first-party managed MySQL; would require self-hosting MySQL on a Fly Machine.
- **Render** has the same MySQL gap.
- **DigitalOcean App Platform** is similar to Railway in shape and has the same risks of edge-proxy quirks.
- **A single Droplet** running OpenEMR's canonical compose pattern (with our overlay for code and TLS) sidesteps these constraints entirely. We own the network from edge to container; Caddy + Let's Encrypt gives us a real cert; the upstream flex image runs as upstream intends.

**No real PHI in scope.** This is a demo with synthetic patient data, so HIPAA/BAA constraints do not gate the host choice. The architecture still treats data as if it were PHI (no PHI in logs, source-tagged claims, RBAC at the tool layer) so the production story remains defensible — the only deferred item is the actual BAA, which would need to be in place before any real patient data touched the system.

**Code-deploy mechanism:** The flex image's `EASY_DEV_MODE_NEW=yes` runs OpenEMR from a host bind-mount instead of from code baked into the image. The release layout is `/srv/openemr/releases/<sha>/` per release with `/srv/openemr/current` as an atomic symlink that the openemr container bind-mounts read-only. `infra/runner-bootstrap.sh` fetches new commits, cuts a release dir, swaps the symlink, and exec's into the new release's `infra/deploy.sh`. `deploy.sh` recreates the openemr container, runs `composer install` / `npm install` / `npm run build` / `composer dump-autoload`, applies pending Doctrine migrations via `./cli migrations:migrate --no-interaction --allow-no-migration`, and polls `/meta/health/readyz`. A failed step (including a failed migration) rolls the symlink back to the previous release.

**Database migrations** use upstream OpenEMR's two-system layout: legacy `sql/database.sql` + per-version `*_upgrade.sql` files driven by the flex entrypoint's `EASY_DEV_MODE=yes` for OpenEMR's own schema, and Doctrine Migrations under `db/Migrations/Version*.php` for new schema this project adds. Doctrine Migrations was merged upstream in PR #10704 (Feb 2026) as the planned successor; we use it for new tables (the first non-bootstrap migration is `Version20260430000001` for the `agent_request_log` table + `disclosure-ai-treatment` list seed). Both systems run automatically on every deploy — the flex entrypoint handles the legacy install/upgrade and `deploy.sh` runs `./cli migrations:migrate`. CI exercises Doctrine migrations on every push via `.github/workflows/database.yml`.

**CI/CD:** GitLab CI/CD on master triggers `runner-bootstrap.sh` on a project-specific runner that lives on the Droplet itself (shell executor, tag `openemr-droplet`). The two-script split (bootstrap = symlink swap + exec; deploy = container recreate, build steps, migrations, healthcheck) means deploy-logic changes apply on the deploy that lands them. Manual fallback for hotfixes is `ssh root@emr.biograph.dev sudo -u gitlab-runner bash /srv/openemr/current/infra/runner-bootstrap.sh`.

**Infrastructure as code:** `doctl` CLI + a checked-in `cloud-init.sh.template` (rendered with secrets at provision time by `infra/bootstrap-do.sh`). Terraform was considered and rejected: with one Droplet to provision, Terraform is overhead, not leverage. The cloud-init script is itself the source of truth for "what the box does on first boot," and it's in version control. The migration story to Terraform-on-ECS or similar at higher scale is documented as a future-cost-analysis bullet rather than built now.

**Rollback strategy:** `git checkout <previous-commit>` on the Droplet, then `docker compose up -d`. Code is the deploy unit, not images. For Caddy/MariaDB rollbacks, the compose file's pinned image digests give a clean reversion path.

**Monitoring:** LangSmith for agent observability (covered in section 8). DigitalOcean's built-in Droplet metrics (CPU, memory, network, disk). Uptime checks via a free external pinger (UptimeRobot or similar) hitting the OpenEMR login page.

**Secrets management:** A single `.env` file at `/opt/openemr/docker/digitalocean/.env` on the Droplet, written once by cloud-init with `chmod 600`. Contains `OE_PASS`, `MYSQL_ROOT_PASSWORD`, `OE_DOMAIN`. Never committed; never in the image. Local development uses a `.env.example` (gitignored — checked in as a template only).

**Reasoning:** The case study explicitly says "infra, keep it simple, not building for DevOps skills." A single Droplet running docker-compose is the simplest defensible deployment that gives us a real domain with a real cert, a database, and our application code shipped from this repo. Using upstream's flex image with bind-mount means the deployment story is "we use OpenEMR's published image as upstream intends, with our code overlaid via the documented `EASY_DEV_MODE_NEW` mechanism" — no custom images to maintain.

The IaC posture (`doctl` + per-Droplet cloud-init + a bootstrap script, no Terraform) is deliberately right-sized. The Droplet is reproducible from a fresh DO account in one command (`infra/bootstrap-do.sh`), but we don't pay the Terraform tax for one resource. If the project ever scales to multiple Droplets or multi-region, the same compose file ports to ECS/GKE/Fly without rework — the lock-in is shallow.

---

### 16. Iteration Planning

**Improvement cycle:** Evals gate quality, demo feedback drives prioritization.

- Every submission, the eval suite runs. If scores drop between submissions, regressions are investigated before adding features.
- Demo videos are watched back to identify friction points — moments where the agent's response wasn't useful, was slow, or required clarification the physician shouldn't have had to provide.
- New features are scoped against existing use cases. If a feature doesn't map to a use case in `USERS.md`, it doesn't get built.

**Long-term maintenance:** Out of scope for the three-week sprint. The architecture should not foreclose long-term maintenance — clean separation of concerns, observability from day one, evals as a regression backstop — but the actual maintenance plan is a week-four concern.

**Reasoning:** Evals as the quality gate prevents the most common failure mode of LLM products: feature drift that silently degrades the core experience. Demo feedback as the prioritization signal keeps the work tied to actual user value rather than what's technically interesting to build. The combination is how production engineering teams actually operate — and it's what the case study is asking for when it says the project should be defensible "in front of a hospital CTO."

---

### 17. UI Integration

**Approach:** A new OpenEMR-rendered page (Twig template, served by an OpenEMR controller) that hosts the agent panel as a small JS bundle. The panel appears alongside the existing patient chart workflow so the physician encounters it inside their normal context — not in a separate window, tab, or app.

**Browser-side traffic flow:** The browser only ever talks to OpenEMR's origin. The agent panel calls `/agent/chat` (and similar) on OpenEMR; OpenEMR proxies those requests to the Node agent service over Docker's private network on the same host. There is no second public origin, no CORS, no cross-origin token handling.

**Streaming:** Server-Sent Events from the agent through OpenEMR's proxy to the browser. SSE is the simplest fit for the streaming requirement implied by the 3–7 second response target — without streaming, perceived latency makes the panel feel broken; with streaming, time-to-first-token is the experienced latency.

**Alternatives rejected:**
- A standalone SPA on its own domain (cleanest separation, but requires CORS, separate deployment story, separate auth, and is a worse demo because it doesn't appear *in* the chart).
- A direct injection of the agent UI into existing OpenEMR pages via JS (best UX, but requires touching legacy jQuery/Angular 1.8 code paths and increases the risk of breaking unrelated UI).

**Reasoning:** The case study's "90-second window between patient rooms" is the experience that has to feel right. Putting the panel on a dedicated OpenEMR-rendered page (rather than wedging it into existing chart pages) is the simplest defensible compromise — the panel is one click from the chart, in OpenEMR's chrome, with no cross-origin complexity. A dedicated page also gives us a clean test surface and an obvious place to evolve toward an in-chart panel later if the UX warrants it.

---

### 18. Authentication & Service Boundary

**Trust model in one sentence:** The agent service has no public identity, no users of its own, and no privileges beyond what the requesting physician could already do in OpenEMR.

**Why not SMART on FHIR / OAuth2 client registration:** The agent is an internal feature of *this* OpenEMR instance, not a third-party app integrating with arbitrary EHRs. SMART/OAuth2 client registration solves a portability problem we don't have. Adopting it would add a client-registration script, key rotation runbook, OAuth2 dance in the browser, and session storage independent of OpenEMR — all overhead with no payoff at this scope. SMART compliance is a deferred decision: if the app ever needs to integrate with Epic/Cerner/etc., we re-evaluate. See "Future portability" below.

**Browser-to-OpenEMR:** Standard OpenEMR session (existing). The physician logs into OpenEMR; the agent panel is rendered inside an authenticated page; subsequent requests carry OpenEMR's session cookie. No new auth in the browser.

**OpenEMR-to-agent (proxy hop):** OpenEMR validates the session, then proxies the request to the agent service on the private network. Before proxying, OpenEMR mints a short-lived OAuth2 access token via its own existing OAuth2 server (League OAuth2) — using the client credentials grant with the acting user's identity baked into the token. The token is attached to the proxied request as a bearer token. The agent never sees the OpenEMR session cookie; it only sees the bearer token.

**Proxy mechanism — a PHP controller, not Apache mod_proxy.** A new OpenEMR controller registered for `/agent/*` handles every proxied request. The controller validates the session, mints the OAuth2 token, opens a streaming HTTP request to the agent service over Docker's private network, and pipes the response back to the browser preserving SSE framing.

Apache mod_proxy alone was rejected because it has no way to invoke OpenEMR's PHP-based OAuth2 server before forwarding — a pure-Apache proxy would forward requests with only the OpenEMR session cookie, which is useless to the agent. A hybrid pattern (PHP exchanges the session for a bearer token, browser holds the token, Apache proxies subsequent requests) was rejected because it puts the bearer token in the browser, walking back the BFF posture this section commits to.

**Token mint is in-process, not over HTTP.** The proxy controller invokes the League OAuth2 server's grant classes directly to mint the JWT, rather than making a self-loopback HTTP call to OpenEMR's own `/oauth2/{site}/token` endpoint. This avoids an extra HTTP round-trip and an extra PHP-FPM worker per agent request. The tighter coupling to OpenEMR's OAuth2 internals is acceptable because the proxy controller lives inside OpenEMR and is deployed with it.

**Scaling note (deferred).** The proxy controller pins one PHP-FPM worker for the duration of each streaming response (5–30 seconds). At the 5–15 concurrent user scale of a family practice (section 2) this is comfortable. At hospital scale (300+ concurrent clinical users from the case study) it becomes a worker-pool concern, and the documented future-work item is to terminate streaming at a Node-side layer outside PHP-FPM (e.g., a thin auth-validating proxy in Node, with PHP only invoked for the initial token mint). This is a production-cost-analysis bullet, not a current implementation concern.

**Agent-to-OpenEMR (tool calls):** The agent forwards the bearer token it received on every API call back into OpenEMR's REST/FHIR API. OpenEMR's existing `OAuth2AuthorizationListener` + `AuthorizationListener` validate the token, extract the acting user, and enforce ACL — the same code path that protects every other API consumer. The agent makes no authorization decisions of its own.

**Token characteristics:**
- Short lifetime (5–15 minutes; doesn't outlive a single agent request).
- No refresh tokens. If the agent needs to call back later, OpenEMR mints a new token on the next proxy hop.
- Scoped to the minimum needed: `openid fhirUser api:fhir user/Patient.rs user/Condition.rs user/AllergyIntolerance.rs user/Observation.rs user/MedicationRequest.rs user/Encounter.rs user/Appointment.rs`.
- Carries the acting user's `fhirUser` claim (`Practitioner/{uuid}`) — used both by OpenEMR for ACL and by the agent for observability tags.

**Network boundary:** The agent service is not reachable from the public internet. The Caddy reverse proxy on the Droplet only routes `emr.biograph.dev` to the OpenEMR container; the agent container is on the same Docker network but has no public route. This is the load-bearing assumption for the trust model — if the agent were reachable from outside, the bearer token would have to be treated as the only line of defense, and we'd want a second layer (mTLS or a shared secret on the proxy hop). Behind the private network, the proxy header path is sufficient.

**No agent-side session storage.** The agent is stateless with respect to user sessions. It does not store tokens, does not store user identities between requests, does not run a session store. Every tool call is self-contained — token in, data out. Conversation state lives in LangGraph's run state and is keyed by an opaque conversation ID issued per browser session.

**Logout:** Handled entirely by OpenEMR's existing logout. Because the agent has no session of its own, there is nothing to invalidate on the agent side. In-flight requests using a token already minted will complete; new requests after logout fail at OpenEMR's session check before the proxy hop.

**FHIR-by-default for tool endpoints:** All five tools call OpenEMR's FHIR R4 endpoints rather than its OpenEMR-specific REST API, even though the agent itself is an internal feature. The reasoning is portability: FHIR responses follow versioned, documented shapes (US Core profiles), so if the app ever needs to integrate with another EHR (Epic, Cerner, Athena, etc.) the tool layer is largely a base-URL swap plus an OAuth2 client registration rather than a full rewrite. The cost is verbosity — FHIR resources have many fields the LLM doesn't need — which we mitigate by mapping FHIR responses to a smaller agent-internal shape before handing data to the model. The one exception is the appointment search, where OpenEMR's FHIR Appointment endpoint lacks a practitioner filter; we extend it with the standard FHIR `practitioner` search parameter rather than introducing a non-standard custom endpoint, keeping the FHIR story consistent across all five tools.

**Future portability (deferred, documented):** If the app ever needs to integrate with another EHR, the agent's tool layer is the abstraction boundary. Because tools are FHIR-based, swapping OpenEMR for another EHR means changing the base URL, registering an OAuth2 client with the new EHR, and adjusting any OpenEMR-specific quirks — not rewriting tools from scratch. Nothing in the agent's architecture forecloses this; it's deferred work, not architectural debt.

**Reasoning:** This is the simplest defensible auth posture for an integrated feature. It makes one strong assumption (the agent is on a private network behind OpenEMR) and inherits everything else from OpenEMR's existing security model. The trust story is short enough to defend in one sentence: "the agent has no privileges of its own; it makes API calls as the requesting physician, and OpenEMR enforces what that physician can see." Choosing OAuth2 token minting (option B from the audit) over a custom trusted-header path (option A) means we don't add a new auth code path to OpenEMR — we reuse the OAuth2 server that already exists, on the inside, without exposing it to the browser. Every alternative considered (SMART client registration, BFF with Redis, custom JWTs, asymmetric keypair-per-environment) was a production pattern designed for problems we don't have at this scope, and adding any of them would have been overengineering.

---

### 19. Conversation State & Persistence

**What we persist:**

1. **LangGraph run state per conversation turn** — the user's question, tool calls and their FHIR responses, the retrieval agent's tagged output, the verification agent's verified/stripped claims, and the final response. This is the structured state the LangGraph engine checkpoints between nodes.
2. **Conversation history per user** — message thread plus a sticky "current patient context" so the physician doesn't have to re-specify the patient on every turn.
3. **Audit log of every query** — who asked, when, what tools fired, verification pass/fail, the conversation ID. Audit log entries do not duplicate full content; they reference conversation IDs so content lives in one place.

**Storage:** Postgres, a separate engine from OpenEMR's MariaDB. On DigitalOcean we run it as a fourth container on the same Droplet (added to `docker/digitalocean/docker-compose.yml` when the agent service is added) or as a DO managed Postgres if we outgrow the single-Droplet shape. Engine choice is the load-bearing decision; host shape is fungible.

**Why Postgres over MySQL** (initial lean was MySQL to reuse the existing instance):
- LangGraph has a first-party Postgres checkpointer; MySQL would require writing and maintaining a custom checkpointer adapter (~100–200 lines plus tests, plus keeping it in sync with LangGraph upgrades). That work buys nothing the case study cares about.
- Postgres `JSONB` with GIN indexing is materially better-suited to LangGraph state (large, nested, JSON-shaped) than MySQL's `JSON` type.
- Physical separation from OpenEMR's database means a compromised agent service cannot reach OpenEMR's tables through shared credentials — the boundary is at the engine level, not just the credential level.

**Why a separate DB at all** (rejected: in-memory, SQLite-on-volume, Redis):
- In-memory loses state on every redeploy, fails under any horizontal scaling, and provides no audit trail.
- SQLite on a host volume works for one instance but bakes "one instance forever" into the architecture. Not foreclosed by current scale, but not architecturally honest either.
- Redis is the wrong durability shape for audit logs and long-tail conversation history.

**LangGraph checkpointer:** First-party Postgres checkpointer wired in at agent startup, schema managed by LangGraph's own migrations.

**PHI-equivalent treatment.** Conversation state contains patient data (the user's question may name a patient; the response contains patient data verbatim). It is treated as PHI even though the demo uses synthetic data:
- Encrypted at rest via the host's disk encryption (Droplet volumes are encrypted at rest by default; if we move to managed Postgres later, the same property holds).
- Credentials scoped to the agent service only; OpenEMR has no access to this database.
- Retention policy: documented as a deferred operational concern. A real production deployment would set retention to match HIPAA audit requirements (typically 6 years); for the demo we set a short retention window and call out the production policy in `AUDIT.md`.
- Logs and observability traces (LangSmith) reference conversation IDs only — never full content — so PHI lives in one durable place.

**Local dev:** Postgres added as a service in `docker/development-easy/docker-compose.yml` alongside the existing MySQL. One more container, no host-side setup.

**Reasoning:** This is the simplest defensible answer for "where does the agent's state live." The deciding factor was LangGraph checkpointer support — every other consideration was a tiebreaker. Putting the agent's state in its own engine, separate from OpenEMR's, also makes the trust boundary cleaner: agent compromise reaches only conversation data, not patient records.

---

## Open Decisions (deferred)

The following decisions are intentionally deferred. The architecture does not foreclose any of these — each is a contained choice that can be made without rework when we get to it. They are listed here so we don't lose them.

### Monorepo layout details

Top-level shape agreed: `/agent/` for the Node service, `/infra/` for deployment scripts, `/docker/digitalocean/` for the production compose stack. The interior layout of `/agent/` (folder structure, build setup, test layout) is TBD and will be decided when scaffolding starts.

### Where the agent panel surfaces in OpenEMR's UI

Section 17 commits to an OpenEMR-rendered page hosting the agent panel, but does not yet specify how the physician reaches that page. Options to evaluate:
- A top-level menu item in OpenEMR's main navigation.
- A button on the patient chart that opens the panel with the current patient pre-selected.
- Both — a top-level entry for general use plus chart-level buttons for in-context launches.

This decision shapes which OpenEMR navigation patterns and Twig templates we hook into. Defer until we touch the UI work.

### ~~Conversation lifecycle and "current patient" stickiness~~ — RESOLVED

**Resolved (2026-04-29) in `docs/IMPLEMENTATION_PLAN.md` "Locked Decisions" #6:** one conversation per `(user, patient)` pair. The conversation row is created on first chart open; if an appointment is in scope, the conversation is also linked to the appointment so the morning-prep view (UC5) can render without re-creating threads.

This narrows cross-patient leakage risk (no patient context shifts inside a conversation) and makes the audit story simple — the disclosure log keys on patient and the engineering log keys on `request_id` (UNIQUE, derived from JWT `jti`) for idempotency.

### Proxy controller failure modes

Section 11 specifies tool-level failure behavior. The OpenEMR-side proxy controller is one layer up and needs its own contract:
- Request timeout when the agent service is slow or unreachable.
- Retry policy (we likely want zero retries at the proxy hop — retries belong inside the agent — but this should be explicit).
- What the user sees when the agent service is down. Section 11's "fail closed for safety-critical, fail open for the rest" doesn't apply at the proxy level since the proxy doesn't know which tool was about to be called.

### Local dev compose file changes

Section 15 commits to adding the agent and Postgres as services in `docker/development-easy/docker-compose.yml`. The exact compose configuration (image build vs. published image, volume mounts, env var seeding, network wiring to the existing OpenEMR + MySQL containers) is TBD and will be decided when we set up the dev environment.

### FHIR Appointment endpoint extension scope

Section 7 commits to extending OpenEMR's existing FHIR Appointment endpoint with a `practitioner` filter for the schedule tool. The size of that PHP change is unverified — it may be 20 lines or 200 depending on the existing controller's structure. If it turns out larger than expected, the documented fallback is a custom REST endpoint at `/api/provider/{uuid}/schedule`. Decision deferred until we read the controller.

### Conversation state retention policy

Section 19 calls out PHI-equivalent treatment for conversation state and defers the retention policy to `AUDIT.md`. Specific retention windows (how long conversation threads, audit logs, and unverified-claim debug logs are kept) are TBD. For the demo, a short window is fine; the production policy needs to match HIPAA audit requirements.

### Eval-runtime model swap

Section 6 documents that the verification agent could be swapped to Haiku as a future cost optimization. Section 9 raises a related question: should the eval suite specifically use the cheaper model on CI runs even if production uses Sonnet for both? This is a cost-control question for CI, deferred until we see real eval-suite cost numbers.

### Schema-drift smoke test

Mentioned during integration design but not yet captured in section 9's eval tiers: a permanent eval case per tool that runs against a known synthetic patient and asserts non-empty, well-shaped output. Catches OpenEMR upgrades or FHIR endpoint changes that would silently break a tool. Defer until the first eval suite is up.

### Agent-side observability beyond LangSmith

Section 8 covers LLM-level observability via LangSmith. The agent service itself (Node process, HTTP handlers, Postgres queries) has its own observability needs (request rate, error rate, p50/p99 latency, Postgres connection pool health). DigitalOcean's Droplet metrics cover host-level resource use; service-level metrics need either container stats (`docker stats` exported) or an OpenTelemetry pipeline. Deferred.

---

## Decision Summary

| Decision Area | Choice |
|---|---|
| Primary user | Primary care physician, 20-patient day |
| Core moment | 90-second window before patient room |
| Scale | 5-15 concurrent users (family practice) |
| Response time target | 3-7 seconds with loading state |
| Agent framework | LangGraph.js |
| Architecture | Two-agent pipeline (retrieval + verification) |
| LLM | Claude Sonnet 4 (both agents) |
| Tools | 5 (`get_patient_summary`, `get_recent_labs`, `get_medications`, `get_recent_encounters`, `get_todays_schedule`) |
| Verification approach | Source tagging at retrieval time |
| Hard clinical stops | Allergies, drug interactions, dosage thresholds |
| Observability | LangSmith |
| Eval framework | Vitest, fully automated |
| CI/CD | GitLab CI/CD (MRs + nightly) |
| UI integration | OpenEMR-rendered page with embedded JS panel; SSE streaming through OpenEMR proxy |
| Browser auth | OpenEMR session (existing, unchanged) |
| Agent auth | Internal-only service on private network; OpenEMR mints short-lived OAuth2 token per proxied request |
| Tool data path | HTTP wrappers over OpenEMR REST/FHIR API — no direct DB access, LLM never produces SQL |
| RBAC | Delegated to OpenEMR's existing ACL — agent enforces nothing |
| Deployment | DigitalOcean Droplet, docker-compose (mariadb + flex openemr with bind-mount + Caddy on Let's Encrypt), one environment for now, doctl + cloud-init as IaC (no Terraform) |
| Conversation state | Postgres (separate from OpenEMR's MariaDB), LangGraph first-party Postgres checkpointer — host TBD when we add the agent service |
| Conversation lifecycle | One conversation per `(user, patient)` pair; linked to an appointment when one is in scope (resolves §"Open Decisions") |
| Disclosure logging | Two-table dual-write: OpenEMR's `extended_log` for the regulatory trail (deduped per actor/patient/day, surfaces in §164.528 reports) + a new `agent_request_log` table for engineering instrumentation. Single Symfony event, one listener, two recorders. Neither table stores prompt/completion content. |
| HIPAA classification | TPO use under §164.506(c) with Anthropic BAA; we log to `extended_log` anyway because OpenEMR's interpretive stance is that TPO disclosures are patient-visible. Full analysis lives in the module's help panel. |
| Schema migrations | Doctrine Migrations under `db/Migrations/` (new schema) + upstream's existing legacy `sql/*_upgrade.sql` system (OpenEMR's own schema). Both run automatically on every deploy. |
| License | GPL-3.0 inherited from OpenEMR |
