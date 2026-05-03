# Eval results — Clinical Co-Pilot

**Last refreshed:** 2026-05-02 against `master @ 479b83faf`.
**Re-run:** `cd agent && npm install && npm test`.

This document is regenerated each submission per
[`docs/IMPLEMENTATION_PLAN.md` §6.4](IMPLEMENTATION_PLAN.md#64-documentation).
For *how* the eval system works (the three-layer architecture, the
"every bug becomes a permanent eval case" rule, when to bump dataset
versions), see [`/CLAUDE.md` § "Agent evals (`agent/evals/`)"](../CLAUDE.md)
and [`ARCHITECTURE.md` § "Evaluation Architecture"](../ARCHITECTURE.md#evaluation-architecture).

## Headline

| Metric | Value |
| --- | --- |
| Test files | 65 passed |
| Tests | 432 passed, 1 skipped |
| Wall time | ~2.9 s (M2 laptop, deterministic — no network) |
| Coverage layer 1 (deterministic gate) | All UC1–UC5 paths green |
| Coverage layer 2 (LangSmith experiment) | 3 datasets uploaded; nightly run scheduled |

The skipped test is the live LangSmith trace-scan probe in
`agent/tests/observability/scanRecentTraces.test.ts`, which only runs
when `LANGSMITH_API_KEY` is set in the environment. The fixture-mode
half of that file runs unconditionally.

## Per-area breakdown

| Area | Files | Tests | What it pins |
| --- | ---: | ---: | --- |
| `tests/auth/` | 3 | 16 | JWT verification (RS256, JWKS rotation, contract envelope), middleware. |
| `tests/snapshot/` | 2 | 25 | `ChartSnapshot` decode + contract — every adapter must produce a snapshot the verifier can index. |
| `tests/tools/` | 8 | 47 | Per-tool callbacks: `getPatientContext`, `getRecentLabs`, `getLabHistory`, `getRecentEncounters`, `getPrescriptions`, `getPrescriptionProvenance`, snapshot client, agent HTTP. |
| `tests/state/` | 5 | 37 | LangGraph Postgres checkpointer wiring, conversation store, schedule-briefings log. |
| `tests/graph/` | 16 | 103 | Graph topology, prompt contracts, branch routing for each UC. |
| `tests/verify/` | 2 | 43 | Claim ledger + verifier — the gate every claim has to clear. |
| `tests/server/` | 11 | 95 | HTTP routes, SSE framing, briefing runner, scope enforcement, error envelope. |
| `tests/observability/` | 5 | 26 (+1 live) | PHI redaction in logs + traces, in-memory counters, LangSmith trace metadata. |
| `evals/runners/` | 1 | 6 | LangSmith dataset uploader idempotency. |
| `evals/cases/` | 12 | 34 | **Pinned eval cases — see breakdown below.** |
| **Total** | **65** | **432 (+1 skipped)** | |

## Eval cases (`evals/cases/`)

The Vitest gate stubs the synthesizer and asserts the deterministic
gate's behavior — verifier accept/reject, safety hard-stop, segment
redaction. This is the per-MR layer; nondeterministic Anthropic calls
live in the nightly LangSmith experiment instead.

### UC1 — default briefing (16 tests across 7 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `uc1/archetypes.test.ts` | 6 | Happy path for each of `healthy_adult`, `hypertensive`, `diabetic`, `diabetic_uncontrolled`, `complex_elderly`, `recent_ed_visit`. Verifier accepts every claim; ground-truth diagnosis codes + medication names appear in the accepted ledger; no segment is redacted. |
| `uc1/failClosed.test.ts` | 3 | Snapshot with missing allergies / missing medications produces a `gap` claim, never a fabricated value. Graph wires the gate. |
| `uc1/promptInjection.test.ts` | 1 | Adversarial encounter note tries to make the model emit a citation that isn't in the snapshot. Verifier rejects with `source-record-not-in-snapshot`. |
| `uc1/crossPatient.test.ts` | 1 | Snapshot endpoint returns 403 when a principal asks for a chart they don't own. **Zero tokens spent** (rejection happens at the proxy, before the agent runs). |
| `uc1/externalCare.test.ts` | 5 | UC4 outside-care scenarios: recent ED visit imported via CCDA, patient with no external records, malformed CCDA emits a `gap`. Reuses the §3.6 harness because external encounters merge into `snapshot.encounters`. |
| `uc1/prescriptionChange.test.ts` | 6 | UC3 medication-change cases: lisinopril started 6 weeks ago (matches `USERS.md` UC3), med with no documented indication, med prescribed by an unknown user. |
| `uc1/adversarialReminderAndStatement.test.ts` | 4 | §4.6 reminder-claim with wrong `dueStatus`, medication-statement claim citing a fabricated `MedicationStatement` id — both rejected. |

### UC2 — lab/vitals trend (6 tests across 3 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `uc2/trendUp.test.ts` | 2 | A1c trend up on the `diabetic_uncontrolled` archetype. Faithful claim accepted; adversarial (fabricated value, wrong date, hallucinated record id) rejected. |
| `uc2/trendStable.test.ts` | 2 | A1c trend stable on the `diabetic` archetype, same accept/reject pattern. |
| `uc2/noHistory.test.ts` | 2 | `healthy_adult` — no lab history available; agent emits a `gap` claim, never a fabricated trend. |

### UC5 — morning-prep precompute (2 tests across 2 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `uc5/morningPrepFlagging.test.ts` | 1 | 20-patient day for an opted-in practitioner. Each appointment produces a deterministic `flags` row keyed by `(practitioner_uuid, appointment_id)`. |
| `uc5/idempotency.test.ts` | 1 | Re-running the morning-prep cron over the same `(practitioner_uuid, date)` is a no-op. The settings table's `morning_prep_enabled = FALSE` default means a non-opted-in clinician produces zero rows, zero tokens, zero log lines. |

## LangSmith datasets (nightly experiment layer)

The Vitest gate stubs the model. The nightly experiment runs the real
Anthropic synthesizer against pinned ground truth on these datasets:

| Dataset | Bound to | Defined in | Purpose |
| --- | --- | --- | --- |
| `clinical-copilot-uc1-golden-v3` | UC1 archetype mix + UC4 external care | `agent/evals/runners/langsmithDataset.ts` | Real-model end-to-end check on the default-briefing path. Bump version on schema changes. |
| `clinical-copilot-uc2-trend-v1` | UC2 lab-trend cases | same | Real-model check on the lab-trend follow-up branch. |
| `clinical-copilot-uc5-morning-prep-v1` | UC5 morning-prep flagging | same | Real-model check on the precompute path. |

**Run locally** (requires `LANGSMITH_API_KEY` and `ANTHROPIC_API_KEY`):

```sh
cd agent
npm run evals:upload-dataset    # idempotent — no-op if dataset exists
npm run evals:experiment        # runs the real synthesizer against the dataset
```

**Public LangSmith share link:** _to be populated when the dataset is
made publicly viewable per the §6.5 submission deliverable._

## Adversarial coverage (PDF §"Evaluation")

The PDF's evaluation rubric calls out *"inputs that attempt to extract
information the requester is not authorized to see"* as a required
class. Existing pinned coverage:

- **Cross-patient leakage** — `uc1/crossPatient.test.ts` (proxy 403,
  zero tokens).
- **Prompt injection in encounter notes** — `uc1/promptInjection.test.ts`.
- **Hallucinated record ids** — every UC2 case has an adversarial half
  asserting fabricated ids fail to resolve in `buildIndex`.
- **Free-text adversarial follow-ups** — covered by
  `tests/graph/freeTextFollowUp.test.ts` (cross-patient leakage
  attempts, authorization probes, hidden-data extraction prompts;
  these stay in the graph-tests directory because they exercise the
  follow-up-only path).

Gaps tracked in [`docs/IMPLEMENTATION_PLAN.md` §6.6](IMPLEMENTATION_PLAN.md#66-adversarial-eval-coverage)
— authorization-tier evals, hidden-data extraction outside encounter
notes, malformed model output, cross-conversation leakage.

## How regressions become permanent eval cases

The repo follows the "every bug becomes a permanent eval case" rule
from `CLAUDE.md`. When a prod incident exposes a gap:

1. The Persist node has already saved the failing `ChartSnapshot` —
   pull it from the agent Postgres `unverified_claims` log.
2. Drop it into `agent/evals/fixtures/<uc>/regression-<id>.json`.
3. Add a Vitest case in `agent/evals/cases/<uc>/` that pins what the
   gate should have caught.
4. Re-run `npm test` — red, then green after the fix.

This is the layer that earns the eval suite its keep over time. The
golden archetype set proves the system works on the easy cases the
team designed for; the regression set proves it doesn't quietly
forget hard cases the team didn't.
