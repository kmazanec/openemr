# Cost analysis — agent service

This doc seeds §6.2 ("Cost analysis") with the inputs the morning-prep
precompute introduces in §5.3. Token totals here are upper-bounded
estimates from the §6.1 trace counters, not measured production
numbers — re-measure once the seeded eval set has run for a week.

## Disabled-default (the cost story we ship)

The settings table `agent_practitioner_settings` defaults
`morning_prep_enabled = FALSE` for every newly-imported practitioner
(see migration `db/Migrations/Version20260502000001.php`). The
precompute CLI's read at the top of every cron tick is

    SELECT … FROM agent_practitioner_settings WHERE morning_prep_enabled = 1

— so a practitioner who has never opted in produces:

  * Zero rows read out of the settings table.
  * Zero log lines from the orchestrator (the per-practitioner skip is
    SQL-level, not loop-level).
  * Zero JWTs minted, zero requests to the agent service.
  * Zero LLM tokens spent.

This is the cost-defensibility case for the feature: the work scales
with explicit clinician opt-in, not with the total clinician count.

## Single opted-in clinician

Family-practice rough numbers:

  * 18 slots/clinician/business day (matches the
    `seed:schedule --per-provider-per-day=18` default).
  * 22 business days/month.

→ ~400 UC1 briefings/month/opted-in clinician.

Per-briefing token cost (from §6.1 traces, claude-sonnet-4-6 mix):

  * Input: ~12k tokens (chart snapshot + system + claims + tool defs)
  * Output: ~1.5k tokens (formatted briefing + claims)
  * Cost (Anthropic 2026 rate, sonnet-4-6 input $3/MTok, output $15/MTok):
    `12,000 * 3/1e6 + 1,500 * 15/1e6 ≈ $0.058 / briefing`.

→ ~$23 / month / opted-in clinician for morning prep alone.
   Re-measure once prompt caching lands (§3.4 mostly cache-able);
   expected 40–60% cache hit drops cost-per-briefing roughly in half.

## Hospital tier (300 clinicians, fully opted in)

The PRESEARCH §2 worst case:

  * 300 clinicians × 18 slots/day × 22 business days = ~118.8k briefings/month.
  * At $0.058/briefing: ~$6,890/month for morning prep.
  * Roll-up under prompt caching (~50% hit rate): ~$3,450/month.

This is the line item §6.2 will need to defend in a cost review. The
opt-in default is what makes this number meaningful — clinicians who
use the feature pay for it; those who don't aren't billing tokens for
briefings they would never read.

## Rolling cost surface

`agent/src/observability/counters.ts` already records
`recordModelUsage({ model, inputTokens, outputTokens, costUsd })` on
every Synthesize call. The `setInterval` snapshot in
`agent/src/server/index.ts` logs the rolling total once a minute.
Precompute briefings carry `metadata.precompute = true` so the
LangSmith dashboard can split morning-prep cost from interactive
briefings in the same trace tree.

## Inputs to re-measure for §6.2

  * Mean input/output tokens per UC1 briefing under prompt caching
    (the numbers above are uncached).
  * Settings-table opt-in rate after the panel has been live for a
    sprint — the realistic monthly bill is `(opted-in count) × $23`,
    not the worst case.
  * UC2/3/4 follow-up frequency (§4.x) — these add to the per-briefing
    average but don't change the morning-prep math directly.
