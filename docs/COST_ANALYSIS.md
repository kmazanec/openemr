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

This per-task routing — Haiku for the high-volume happy path, Sonnet
where the larger model earns its premium — is the second largest
cost lever after the morning-prep opt-in. Pinning everything to
Sonnet (the original design) would have raised the typical-mix
numbers above by roughly 3x.

### Per-event cost (measured against production-shaped fixtures)

| Event | Input tokens | Output tokens | Model | Cost / event |
| --- | ---: | ---: | --- | ---: |
| Pre-visit briefing | ~5,000 | ~1,200 | Haiku 4.5 | **$0.0088** |
| Pre-visit briefing (worst case — complex elderly chart) | ~6,500 | ~1,500 | Haiku 4.5 | **$0.0112** |
| Free-text follow-up | ~5,500 | ~1,000 | Sonnet 4.6 | **$0.0315** |
| Lab-trend follow-up | ~5,500 | ~800 | Sonnet 4.6 | **$0.0285** |

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
