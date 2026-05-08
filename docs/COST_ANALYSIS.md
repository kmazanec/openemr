# Clinical Co-Pilot — Cost Analysis

**For:** Executive budget review
**Scope:** Total cost to operate the Clinical Co-Pilot as an embedded
feature inside an OpenEMR deployment, at four organizational tiers.
**Status:** Token volumes and per-feature mix are derived from
production-shaped synthetic traffic; infrastructure costs are real
list prices. Re-baseline once the feature has been live in a real
clinic for a sprint.

---

## Executive summary

| Tier (clinicians) | Variable LLM cost / month (typical mix) | Variable LLM cost / month (worst case, fully opted-in) | Infrastructure cost / month |
| --- | ---: | ---: | ---: |
| 100 clinicians | ~$210 | ~$930 | ~$25 |
| 1,000 clinicians | ~$2,100 | ~$9,300 | ~$110 – $250 |
| 10,000 clinicians | ~$21,000 (~$15,000 with caching) | ~$93,000 | ~$1,000 – $2,500 |
| 100,000 clinicians | ~$208,000 (~$140,000 with caching + enterprise discount) | ~$930,000 | ~$10,000 – $25,000 |

**Two numbers to watch.** The "typical mix" and "worst case" columns
diverge by ~4–5x. The gap is not a modeling uncertainty — it is the
single most important business lever the product exposes. The
worst-case column assumes every clinician opts into the
schedule-aware morning prep feature *and* invokes the briefing on
every chart open *and* asks at least one follow-up per chart. The
typical-mix column assumes interactive briefing on ~30% of chart
opens, ~0.3 follow-ups per briefing, and ~10% of clinicians opted
into morning prep. **The product ships with morning prep disabled
by default**, so a deployment lands near the typical-mix number
unless leadership signs off on broader rollout.

**Cost scales with feature usage, not headcount.** This is a
deliberate architectural property: a clinician who never opens the
panel produces zero rows in the settings table, zero JWTs minted,
zero requests to the agent service, zero LLM tokens. The tier table
above measures *opted-in* clinicians; an organization with 10,000
employees but a 200-clinician pilot pays the 200-clinician bill.

**Variable cost dominates fixed cost.** At every tier, LLM API spend
is the line item that scales linearly with usage. Infrastructure is
a small enough fraction that it does not gate procurement decisions
— even at 100,000 clinicians, infra is under 15% of the total bill.
Budget conversations should focus on the LLM line.

---

## What drives the bill

The Co-Pilot makes one or more LLM calls for each of these events:

1. **Pre-visit briefing.** A clinician opens a patient chart; the
   panel renders a one-screen briefing of medications, active
   problems, allergies, recent labs, and recent encounters.
2. **Follow-up question.** The clinician taps a suggested follow-up
   ("show me the A1c trend", "why is this medication on the list?")
   or types a free-text question in the same panel.
3. **Morning prep precompute** *(disabled by default)*. Overnight,
   for clinicians who have opted in, the system pre-renders briefings
   for every patient on the next day's schedule. The clinician opens
   the morning's chart and the briefing is already there.
4. **Document extraction** *(W2)*. When a clinician attaches a lab PDF
   or intake form, the ingestion pipeline runs one vision LLM call
   (Claude Sonnet 4.x) per document to extract structured facts.
   This is a one-time cost per document; subsequent references to the
   same document are served from the `extraction_artifacts` cache at
   zero additional LLM cost.
5. **Guideline evidence retrieval** *(W2)*. When the supervisor routes
   to the `evidenceRetriever`, one OpenAI embedding call encodes the
   query, one Pinecone hybrid-search query returns candidate chunks,
   and one Cohere rerank call orders the top results. These fire once
   per supervisor iteration that invokes the evidence retriever.

Each of those events spends tokens against the Anthropic API.
Everything else — auth, audit logging, conversation persistence,
chart-snapshot retrieval — runs against the local database and
carries no per-event LLM cost.

### The model mix

| Path | Model | Input price | Output price | Why this model |
| --- | --- | ---: | ---: | --- |
| Default briefing | Claude Haiku 4.5 | $0.80 / 1M tok | $4.00 / 1M tok | Structured retrieval over a known chart snapshot — Haiku handles the format-and-cite work at ~4x lower cost than Sonnet. |
| Free-text follow-up | Claude Sonnet 4.6 | $3.00 / 1M tok | $15.00 / 1M tok | Free-form clinician questions benefit from the larger model; this path runs only on user-initiated follow-ups, so the higher per-call cost lands on the small minority of events. |
| Lab-trend follow-up | Claude Sonnet 4.6 | $3.00 / 1M tok | $15.00 / 1M tok | Interpreting a multi-point analyte trend with reference ranges — same reasoning as free-text. |
| Supervisor (W2) | Claude Sonnet 4.6 | $3.00 / 1M tok | $15.00 / 1M tok | The W2 supervisor is an LLM call per iteration. Typical turns see 3–6 supervisor iterations; the iteration cap of 10 is the hard ceiling. Supervisor prompts are short (closed-enum handoff manifest + state summary) so per-iteration token count is modest. |
| Document vision (W2) | Claude Sonnet 4.6 | $3.00 / 1M tok | $15.00 / 1M tok | Vision extraction of lab PDFs and intake forms. One call per document upload. Input includes rasterized page images (billed as image tokens) + the strict Zod extraction schema; output is structured JSON. |
| Embedding (W2) | OpenAI text-embedding-3-large | $0.13 / 1M tok | — | Per-query embedding for `evidenceRetriever`. Single short query string per retriever invocation. |
| Rerank (W2) | Cohere rerank-v3.5 | $2.00 / 1K searches | — | Top-20 Pinecone results reranked to top-3. One rerank call per `evidenceRetriever` invocation. |

This per-task routing — Haiku for the high-volume happy path, Sonnet
where the larger model earns its premium — is the second largest
cost lever after the morning-prep opt-in. Pinning everything to
Sonnet (the original design) would have raised the typical-mix
numbers above by roughly 3x.

### Per-event cost (measured against production-shaped fixtures)

| Event | Input tokens | Output tokens | Model | Cost / event |
| --- | ---: | ---: | --- | ---: |
| Pre-visit briefing (W1) | ~5,000 | ~1,200 | Haiku 4.5 | **$0.0088** |
| Pre-visit briefing (worst case — complex elderly chart) | ~6,500 | ~1,500 | Haiku 4.5 | **$0.0112** |
| Free-text follow-up (W1) | ~5,500 | ~1,000 | Sonnet 4.6 | **$0.0315** |
| Lab-trend follow-up (W1) | ~5,500 | ~800 | Sonnet 4.6 | **$0.0285** |
| Supervisor — per iteration (W2) | ~2,000 | ~200 | Sonnet 4.6 | **$0.0009** |
| Supervisor — typical turn (3–4 iterations) | ~8,000 | ~800 | Sonnet 4.6 | **$0.0036** |
| Supervisor — worst-case (10 iterations, cap hit) | ~20,000 | ~2,000 | Sonnet 4.6 | **$0.0090** |
| Document vision — lab PDF (4 pages) | ~8,000 img+text | ~3,000 | Sonnet 4.6 | **$0.069** |
| Document vision — intake form (2 pages) | ~5,000 img+text | ~2,000 | Sonnet 4.6 | **$0.045** |
| Guideline evidence retrieval (W2) | ~300 embed | — | OpenAI embed-3-large | **$0.000039** |
| Guideline evidence retrieval — rerank (W2) | 20 results | — | Cohere rerank-v3.5 | **$0.002** |

Document vision token costs include image tokens (billed per 1K
image pixels / 750 input tokens equivalent for Sonnet 4.x image
pricing). The $1.00 per-document hard cap in
`agent/scripts/check-cost-cap.ts` bounds any single extraction.

The supervisor cost is per conversational turn that involves
retriever decisions; a simple chart-only briefing with no attached
documents and no guideline retrieval may skip the supervisor
entirely (the W1 deterministic branch still handles it directly).
For W2 turns where the supervisor runs, the typical 3–4 iteration
cost ($0.0036) is dominated by the synthesizer itself ($0.0285)
and is not a meaningful line item until volume scales.

Input volume is dominated by the system prompt (~3,700 tokens, the
clinical-safety framing and citation requirements) and a compact
chart-snapshot JSON (~400–2,000 tokens depending on chart depth).
Output is a structured response with cited claims; the clinical
verification layer (which strips any uncited claim before the
clinician sees it) keeps output volume bounded.

---

## Tier 1 — 100 clinicians

A small primary-care group, single facility, single timezone.

**Assumed usage mix (typical):**
- 100 clinicians, ~80 active on a given business day.
- 18 patients/clinician/day × 22 business days = ~31,700 chart opens/month.
- Briefing rendered on 30% of opens = ~9,500 briefings/month.
- ~0.3 follow-ups per briefing on average = ~2,850 follow-ups/month.
- Morning prep enabled by ~10 clinicians.

| Line item | Quantity | Unit cost | Monthly cost |
| --- | ---: | ---: | ---: |
| Briefings (interactive) | 9,500 | $0.0088 | $84 |
| Follow-ups | 2,850 | $0.0315 | $90 |
| Morning prep (10 opted-in clinicians × 18/day × 22 days) | 3,960 | $0.0088 | $35 |
| **LLM subtotal** | | | **~$209** |

The "typical" range in the executive summary table is wider than
this single point estimate because adoption ramps slowly — the
$30–$75 floor reflects an early-pilot deployment with single-digit
opted-in clinicians, and the $230 number above reflects a mature
deployment with the 10% morning-prep adoption assumed in the table.

**Worst case** (every clinician opted into morning prep, every chart
gets an interactive briefing too): 100 × 18 × 22 = 39,600 morning-prep
briefings + 31,700 interactive briefings + ~9,500 follow-ups ≈ $930.
This is the ceiling; nothing about the architecture forces the
deployment toward it.

**Infrastructure** at this tier:
- 1× DigitalOcean Droplet, `s-2vcpu-2gb` ($18/mo) — runs
  OpenEMR + agent + Postgres + Caddy in one compose stack.
- Object storage for daily Postgres backups (~$5/mo, DigitalOcean
  Spaces).
- Anthropic API costs above.
- LangSmith free tier (5K traces/mo) covers observability.
- Total infra: ~$23/mo. **No architectural changes needed at this tier.**

---

## Tier 2 — 1,000 clinicians

A mid-sized health system with multiple clinics or a small hospital.

**Assumed usage mix (typical):**
- 1,000 clinicians, ~800 active on a given business day.
- ~317,000 chart opens/month.
- Briefing on 30% = ~95,000 briefings/month.
- ~0.3 follow-ups per briefing = ~28,500 follow-ups/month.
- Morning prep enabled by ~100 clinicians.

| Line item | Quantity | Unit cost | Monthly cost |
| --- | ---: | ---: | ---: |
| Briefings (interactive) | 95,000 | $0.0088 | $836 |
| Follow-ups | 28,500 | $0.0315 | $898 |
| Morning prep (100 opted-in × 18 × 22) | 39,600 | $0.0088 | $349 |
| **LLM subtotal** | | | **~$2,083** |

**Worst case** (full opt-in): ~$9,300/month.

**Infrastructure changes at this tier:**
- The agent service moves off the OpenEMR Droplet to its own host
  (or a small container service) — agent load is now in the
  thousands of concurrent requests at peak morning hours rather
  than tens.
- Postgres for agent state graduates from a sidecar container to
  a managed instance (DigitalOcean Managed Postgres `db-s-1vcpu-2gb`
  at ~$30/mo, or AWS RDS equivalent). This is for operational
  reasons — backups, point-in-time recovery, failover — not
  performance, which a single-node Postgres still handles.
- LangSmith moves to a paid tier (~$50/mo) to keep all traces
  rather than sampling.
- Total infra: ~$110–$250/mo, depending on host choice.

**Caching becomes a meaningful lever at this tier.** Anthropic's
prompt caching feature lets the system prompt and chart-snapshot
header (~3,700 + ~500 tokens, the largest fixed portion of every
briefing) be cached for 5 minutes at 10% of the normal input price.
A clinician working through a morning's appointments will cache-hit
on roughly 60–80% of briefings within a session. Realistic savings:
20–30% reduction in LLM cost. We have not built this in yet — it is
a documented optimization for a future sprint, called out here
because at $2K/month it is worth the engineering hour to implement.

---

## Tier 3 — 10,000 clinicians

A large integrated delivery network, multi-state, or a national
specialty group.

**Assumed usage mix (typical):**
- 10,000 clinicians, ~8,000 active on a given business day.
- ~3.17M chart opens/month.
- Briefing on 30% = ~950,000 briefings/month.
- ~0.3 follow-ups per briefing = ~285,000 follow-ups/month.
- Morning prep enabled by ~1,000 clinicians.

| Line item | Quantity | Unit cost | Monthly cost |
| --- | ---: | ---: | ---: |
| Briefings (interactive) | 950,000 | $0.0088 | $8,360 |
| Follow-ups | 285,000 | $0.0315 | $8,978 |
| Morning prep (1,000 opted-in × 18 × 22) | 396,000 | $0.0088 | $3,485 |
| **LLM subtotal** | | | **~$20,823** |

After applying realistic prompt caching (assumed implemented before
reaching this scale): **~$15,000–$16,000/month.**

**Worst case** (full opt-in, no caching): ~$93,000/month.

**Infrastructure changes at this tier:**
- Agent service runs as a horizontally-scaled deployment (3–6
  replicas behind a load balancer). The agent is stateless with
  respect to user sessions — conversation state lives in Postgres,
  not in the process — so this is straightforward.
- Postgres scales to a multi-AZ managed instance with read
  replicas (~$300–$600/mo).
- Object storage and CDN for the agent's static assets
  (~$50/mo).
- Enterprise observability — LangSmith team or enterprise plan,
  or a self-hosted Langfuse / OpenTelemetry pipeline (~$500/mo).
- An Anthropic enterprise commitment (volume discount + SLAs)
  becomes worth negotiating; expect 10–20% off list prices at
  this volume, which would reduce the LLM subtotal proportionally.
- Total infra: ~$1,000–$2,500/mo.

**Retention policy starts to matter for cost.** Conversation state
and audit logs are bounded by HIPAA's 6-year retention requirement
for the regulatory trail, but the engineering audit table
(`agent_request_log`, currently uncapped) and the LangGraph
checkpointer state can be aged off aggressively — a 90-day window
for engineering data and a tiered cold-storage move for older
HIPAA-mandated audit rows keeps Postgres costs flat as the
deployment ages.

---

## Tier 4 — 100,000 clinicians

National-scale deployment — a top-tier IDN, a federal system (VA),
or a multi-tenant hosted offering.

**Assumed usage mix (typical):**
- 100,000 clinicians, ~80,000 active on a given business day.
- ~31.7M chart opens/month.
- Briefing on 30% = ~9.5M briefings/month.
- ~0.3 follow-ups per briefing = ~2.85M follow-ups/month.
- Morning prep enabled by ~10,000 clinicians.

| Line item | Quantity | Unit cost | Monthly cost |
| --- | ---: | ---: | ---: |
| Briefings (interactive) | 9.5M | $0.0088 | $83,600 |
| Follow-ups | 2.85M | $0.0315 | $89,775 |
| Morning prep (10,000 opted-in × 18 × 22) | 3.96M | $0.0088 | $34,848 |
| **LLM subtotal** | | | **~$208,000** |

After prompt caching and an Anthropic enterprise commitment
(15% list discount): **~$130,000–$145,000/month.**

**Worst case** (full opt-in, no caching, list price): ~$930,000/month.
This number is mostly notional — at this scale Anthropic
negotiations and prompt caching aren't optional, and the typical
mix would never reach this ceiling because the morning-prep opt-in
rate is bounded by clinician interest, not licensing.

**Infrastructure changes at this tier:**
- Multi-region agent deployment. Caching in front of the snapshot
  endpoint becomes meaningful — many clinicians open the same
  patient chart in a single day.
- Postgres becomes a multi-region cluster or moves to a managed
  service like Aurora; cost grows to ~$3,000–$8,000/mo.
- A dedicated SRE team is implied at this scale; that's a
  headcount line item, not an infra line item, but it should be
  in the budget conversation.
- Total infra: ~$10,000–$25,000/mo.

---

## Architectural levers, ranked by impact

If the executive question is "how do we keep this number down,"
these are the levers the product exposes — in order of how much
they move the bill.

1. **The morning-prep opt-in default.** Off by default. A
   clinician who never enables it never produces precompute
   tokens. This is the difference between the "typical" and
   "worst case" columns at every tier. The product makes opt-in
   a per-clinician choice (not per-organization), so individual
   power users can adopt it without the line item exploding.

2. **Per-task model routing (Haiku for briefings, Sonnet for
   follow-ups).** Already implemented. Pinning everything to
   Sonnet would roughly 3x the typical-mix LLM line.

3. **Prompt caching.** Not yet implemented. Estimated 20–30%
   reduction in LLM cost at any tier where a clinician runs more
   than a few briefings per session. Engineering effort: ~1
   sprint. Worth doing before crossing $1K/month in LLM spend.

4. **Volume commitments with Anthropic.** Worth negotiating
   above ~$10K/month in API spend. Typical discount: 10–20%.

5. **Conversation-state retention policy.** Not a per-event lever
   — affects steady-state Postgres cost rather than LLM cost.
   Becomes meaningful at Tier 3+. The HIPAA audit trail must be
   kept; engineering instrumentation can be aggressively rolled
   off.

6. **Verifier model swap (Sonnet → Haiku).** A future
   optimization documented in the architecture but not yet
   implemented. The verification step currently runs as part of
   the same model call as briefing synthesis; splitting it out
   and putting a Haiku verifier in front would add one call but
   reduce the dominant-model token count. Estimated impact
   modest (5–10%); priority lower than caching.

---

## What would change these numbers

The estimates above assume:

- **Anthropic list pricing as of 2026-04.** Anthropic has moved
  prices up and down twice in the last 12 months; a 2x swing in
  either direction is plausible over a 12-month budget horizon.
- **Synthetic chart-shape distribution.** Real charts in a busy
  clinic may have larger encounter histories or more lab data,
  which would push input tokens up by 20–50%. Real charts in a
  pediatric or routine-care setting would push it down.
- **30% briefing-on-chart-open rate.** This is a conservative
  guess at the rate clinicians will actually invoke the panel
  after the novelty wears off. If the rate is closer to 80%
  (the panel becomes a standard part of every chart open),
  multiply the briefings line by ~2.5.
- **0.3 follow-ups per briefing.** Same caveat — early data
  from the dev environment suggests 0.2–0.5; real-world adoption
  may differ.
- **No PHI redaction overhead.** The architecture supports a
  PHI-redaction step at the tool layer for deployments where
  the LLM provider is not under a BAA. If that step is enabled,
  expect a 10–15% increase in LLM cost from the redaction model
  call.

The cost-projection counters in the agent service
(`recordModelUsage` on every model call) record exact token counts
and per-model cost on every request, so as soon as the system has
a sprint of real-clinician traffic these estimates become measured
numbers rather than projections.

---

## Engineering cost — the eval suite and observability

The numbers above are the runtime bill — what a deployed clinic
pays. Separately, building and operating the agent has its own
recurring bill: the eval suite (which runs LLMs on every
agent-touching MR and on a nightly schedule) and the LangSmith
observability platform that backs both evals and production
tracing. These are *engineering-team* costs, not per-clinic costs,
and they don't scale with deployment tier — a 100-clinician
deployment and a 10,000-clinician deployment pay the same eval
bill.

### Per-MR eval gate

The `test:agent-evals-gate` CI job runs every suite's experiment
against real models on each MR that touches agent code, eval
wiring, or the baseline file. It exists to prevent a model-or-prompt
change from silently regressing rubric scores.

| Suite | Cases (current) | Per-case unit | Per-run cost |
| --- | ---: | ---: | ---: |
| `briefing-graph` | 29 | $0.04 | $1.16 |
| `conversational-graph` | 37 | $0.10 | $3.70 |
| `document-extraction` | 26 | $0.06 | $1.56 |
| **Total per gate run** | **92** | | **~$6.42** |

Per-case unit prices are derived from production median token
counts at HEAD across the synthesizer (Anthropic Sonnet 4.6),
embedder (OpenAI `text-embedding-3-large`), retriever
(Pinecone Standard p1), and reranker (Cohere `rerank-english-v3`).
The conversational-graph suite is the dominant line because it
runs the supervisor + retrievers for ~3 turns per case, where the
other two suites are single-pass.

A **$7.50 hard cap per gate run** is enforced in
`agent/scripts/check-cost-cap.ts`; the cost-cap step is the first
thing the gate does, so a runaway dataset growth blocks the
pipeline before any vendor calls fire. Adjust the cap with a
documented justification in `W2_ARCHITECTURE.md` only.

**MR volume → monthly cost.** The gate fires on every MR whose
diff matches the path filter (`agent/src/`, eval runners, rubrics,
baselines, lockfiles, or `.gitlab-ci.yml`). Approximate steady
state during active feature work:

| MR throughput / month | Gate runs / month | Eval-gate LLM spend |
| --- | ---: | ---: |
| 20 MRs (low) | 20 | ~$130 |
| 50 MRs (typical) | 50 | ~$320 |
| 100 MRs (heavy) | 100 | ~$640 |

A rebase that retriggers the pipeline counts as a separate run.
The cap is per-run, not per-MR — a 5-rebase MR pays 5x.

### Nightly experiment

`test:agent-evals-nightly` runs the same experiment shape against
master once per scheduled trigger (currently set up to run nightly
from GitLab → Build → Pipeline schedules). One run = one full
eval-suite cost ≈ **$6.42**. At 30 nights/month: **~$190/month**.

### LangSmith — observability and evaluator infrastructure

LangSmith is wired in for two distinct jobs:

1. **Production tracing.** Every agent tool, graph node, and
   model call emits a trace. PHI is redacted before traces leave
   the agent (`LANGSMITH_HIDE_INPUTS=true`).
2. **Eval feedback storage.** Each `evaluate()` call in the eval
   gate creates an experiment, runs a target trace per example,
   and posts five evaluator child traces per example (one per
   rubric: `schema_valid`, `citation_present`,
   `factually_consistent`, `safe_refusal`, `no_phi_in_logs`).
   The gate reads those feedback rows back via `client.listRuns`
   + `client.listFeedback` to compare against the baseline.

**Trace volume from the eval suite alone.** Per gate run:
92 cases × (1 target + 5 evaluators) = **552 traces**. Per
nightly run: another ~552. At 50 MRs/month + 30 nightly runs:
~44K eval-only traces/month, before any production traffic.

**LangSmith list pricing** (as of 2026-04, Plus tier — verify at
purchase time):
- $39/seat/month, includes 50K base traces/month per workspace.
- $0.0005 per trace beyond the included pool.
- Enterprise tier (volume + SSO + private cloud) negotiated.

**Engineering bill at typical throughput:**

| Line item | Quantity | Unit | Monthly cost |
| --- | ---: | ---: | ---: |
| LangSmith Plus (3 engineers) | 3 seats | $39 | $117 |
| Trace overage (assume ~80K total: ~44K eval + ~36K dev/prod) | ~30K over | $0.0005 | $15 |
| **LangSmith subtotal** | | | **~$132** |
| Eval gate (50 MRs, 1 run/MR) | 50 runs | $6.42 | ~$320 |
| Nightly experiment (30 nights) | 30 runs | $6.42 | ~$190 |
| **Eval LLM subtotal** | | | **~$510** |
| **Engineering total** | | | **~$640/month** |

This is the steady-state bill during active feature development.
It does not scale with the deployment tier — a 100-clinician pilot
and a 10,000-clinician deployment incur the same engineering line
unless the team is also growing.

### Levers for the engineering bill

Ranked by impact, lowest-effort first:

1. **Path-filter discipline on the eval gate.** Already in place
   (`agent/src/`, eval wiring, baselines, lockfiles only).
   Doc-only and PHP-only MRs skip the gate. Without this, every
   MR pays ~$6.42 — at 50 MRs/month that's $320 of avoidable
   spend.
2. **Sample the eval datasets per MR; full coverage nightly.**
   The conversational-graph suite at 37 cases drives 58% of the
   per-run cost. Running a stratified sample of ~10 cases per MR
   (≥1 from each `caseKind`) and the full 37 only on the nightly
   would drop per-MR cost from $6.42 to ~$2.00 without losing
   regression coverage on master. ~1 sprint to wire up.
3. **Project-route evaluator traces.** LangSmith's
   `evaluate(target, { evaluator_project: 'evals' })` sends
   evaluator child traces to a separate project. Doesn't reduce
   trace count but keeps the production-tracing project clean
   and lets retention policies diverge (short TTL on evals,
   long TTL on prod).
4. **Drop the nightly cadence.** If the per-MR gate is doing its
   job, the nightly is a redundant safety net. Saves ~$190/month
   at the cost of slower drift detection on master.
5. **Self-host the observability backend.** Langfuse is an OSS
   alternative with the same trace/feedback shape; running it on
   the same Droplet that hosts OpenEMR is realistic up through
   Tier 2. Saves the LangSmith subtotal at the cost of an
   ops-line — only worth it if engineering scales past ~10
   seats or trace volume balloons past ~500K/month.

### What would change these numbers

- **Dataset growth.** Every case added to a suite multiplies into
  ~6 traces and one model call per gate run. The hard-cap script
  is the cost forcing function — it blocks the pipeline when
  a dataset bump pushes the run total over $7.50.
- **Synthesizer model swap.** The per-case prices assume Sonnet 4.6
  for synthesis. A swap to Opus would 4–5x the eval bill; a swap
  to Haiku for the lower-stakes suites would cut it ~3x. The
  current mix follows the same per-task routing rationale as the
  runtime path: Haiku where it's cheap and good, Sonnet where the
  larger model earns its premium.
- **MR throughput.** A team running 200 MRs/month on agent code is
  paying ~$1,280/month in eval-gate LLM spend at current dataset
  sizes. Crossing $1K/month is the cue to invest in the per-MR
  sampling lever above.
- **LangSmith pricing.** LangSmith's posted price has moved twice
  in the last 18 months. Re-baseline this section after any
  contract change.
