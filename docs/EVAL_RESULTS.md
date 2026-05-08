# Eval results — Clinical Co-Pilot

**Last refreshed:** 2026-05-08 against `master @ 60bfbe245`.
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
| Test files | 126 passed |
| Tests | 1035 passed, 7 skipped (1042 total) |
| Wall time | ~7.5 s (M2 laptop, deterministic — no network) |
| Coverage layer 1 (deterministic gate) | All UC1–UC5 + W2 paths green |
| Coverage layer 2 (LangSmith experiment) | 4 datasets uploaded; nightly run scheduled |

The skipped tests are: the live LangSmith trace-scan probe in
`agent/tests/observability/scanRecentTraces.test.ts` (runs only when
`LANGSMITH_API_KEY` is set), and 6 eval cases that require real vendor
credentials (marked `.skip` in the no-phi suite; they run in CI with
keys populated).

## Per-area breakdown

| Area | Files | Tests | What it pins |
| --- | ---: | ---: | --- |
| `tests/auth/` | 3 | 16 | JWT verification (RS256, JWKS rotation, contract envelope), middleware. |
| `tests/snapshot/` | 2 | 23 | `ChartSnapshot` decode + contract — every adapter must produce a snapshot the verifier can index. |
| `tests/tools/` | 11 | 65 | Per-tool callbacks: `getPatientContext`, `getRecentLabs`, `getLabHistory`, `getRecentEncounters`, `getPrescriptions`, `getPrescriptionProvenance`, snapshot client, agent HTTP. |
| `tests/state/` | 8 | 69 | LangGraph Postgres checkpointer wiring, conversation store, schedule-briefings log, extraction artifacts table. |
| `tests/graph/` | 19 | 166 | Graph topology, prompt contracts, branch routing for each UC, supervisor loop, W2 source-type routing. |
| `tests/verify/` | 3 | 83 | Claim ledger + verifier — the gate every claim has to clear, incl. per-source-type resolution and bbox equality. |
| `tests/server/` | 14 | 148 | HTTP routes, SSE framing, briefing runner, scope enforcement, error envelope, extract endpoint. |
| `tests/observability/` | 5 | 31 (+1 live) | PHI redaction in logs + traces, in-memory counters, LangSmith trace metadata. |
| `tests/pipeline/` | 12 | 109 | **(W2)** Ingestion pipeline nodes: rasterize, vision, schemaValidate, patientMatch, persist, emitDeltas, cleanup. |
| `tests/retrievers/` | 2 | 16 | **(W2)** Pinecone hybrid retriever, Cohere rerank, BM25 sparse encoder. |
| `tests/scripts/` | 5 | 30 | **(W2)** Corpus fetcher/extractor unit tests: CDC, ADA, AGS Beers surface extractors. |
| `evals/runners/` | 2 | 18 | LangSmith dataset uploader idempotency, suite manifest pinning. |
| `evals/cases/` | 31 | 77 | **Pinned eval cases — see breakdown below.** |
| `scripts/` | 4 | 49 | Eval gate, cost-cap precheck, vendor health check, BM25 stats loader. |
| **Total** | **126** | **1035 (+7 skipped)** | |

## Eval cases (`evals/cases/`)

The Vitest gate stubs the synthesizer and asserts the deterministic
gate's behavior — verifier accept/reject, safety hard-stop, segment
redaction. This is the per-MR layer; nondeterministic Anthropic calls
live in the nightly LangSmith experiment instead.

W2 adds three new eval suites (document-extraction, conversational-graph,
no-phi) alongside the W1 suites. The five boolean rubrics cover all four
suites: `schema_valid`, `citation_present`, `factually_consistent`,
`safe_refusal`, `no_phi_in_logs`.

### W2 — document extraction (16 tests across 4 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `document-extraction/lab-pdf/labPdf.test.ts` | 4 | Happy path for lab PDF extraction: schema parses, every field has a bbox, confidence signal is populated, patient match succeeds. |
| `document-extraction/intake-form/intakeForm.test.ts` | 2 | Happy path for intake form extraction: allergy and medication fields extracted, demographics delta computed. |
| `document-extraction/degraded/degraded.test.ts` | 6 | Degraded inputs: low-confidence field dropped (`low-confidence-extraction`), low-confidence allergy triggers category-level fail-closed, over-size document refused at rasterize with `cost-cap-exceeded`, storage-unreachable produces `failed` artifact, schema-invalid retry exhausted, corrupted PDF bytes. |
| `document-extraction/adversarial/adversarial.test.ts` | 4 | Adversarial: patient mismatch refuses extraction with `mismatch_reason`, injected instruction text in scanned page does not propagate into extracted fields, fabricated bbox accepted by vision but rejected by verifier bbox-equality check, duplicate extraction returns cached `artifact_id` without re-running. |

### W2 — conversational graph (16 tests across 6 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `conversational-graph/document-evidence/documentEvidence.test.ts` | 4 | `documentEvidenceRetriever` returns per-patient artifact snippets; out-of-scope pid rejected; rejected/superseded artifacts excluded; query filter by doc_type respected. |
| `conversational-graph/guidelines/guidelines.test.ts` | 4 | `evidenceRetriever` returns guideline chunks; `source_filter` restricts to the requested publisher; Pinecone-outage produces fail-open gap; Cohere-outage produces degraded-mode result without reranking. |
| `conversational-graph/verification/verification.test.ts` | 4 | Verifier accepts `extracted_document` claim with matching bbox; rejects fabricated bbox; rejects fabricated artifact id; low-confidence allergy triggers category-level fail-closed. |
| `conversational-graph/multi-retriever/multiRetriever.test.ts` | 1 | Supervisor invokes both `documentEvidenceRetriever` and `evidenceRetriever` in a single turn; synthesizer cites both source types; verifier accepts all claims. |
| `conversational-graph/refusal/refusal.test.ts` | 2 | Out-of-scope question produces empty `claimGroups` with a safe-refusal phrase; PHI-probe follow-up produces the same shape. |
| `conversational-graph/cap-hit/capHit.test.ts` | 1 | Supervisor forced to `synthesize` at iteration 10 (cap hit); `cap-hit` trace event emitted; response still passes verifier. |

### W2 — PHI in vision traces (3 tests across 1 file)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `no-phi/vision-traces.test.ts` | 3 | Fixture-mode PHI scan: patient name, DOB, and MRN do not appear in the trace body generated by the vision node (verifies `LANGSMITH_HIDE_INPUTS/OUTPUTS` defaults carry through to vision calls). |

### W1 — briefing graph (31 tests across 14 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `archetypes/archetypes.test.ts` | 1 | Happy path for each of `healthy_adult`, `hypertensive`, `diabetic`, `diabetic_uncontrolled`, `complex_elderly`, `recent_ed_visit`. Verifier accepts every claim; ground-truth diagnosis codes + medication names appear in the accepted ledger; no segment is redacted. |
| `archetypes/failClosed.test.ts` | 3 | Snapshot with missing allergies / missing medications produces a `gap` claim, never a fabricated value. Graph wires the gate. |
| `archetypes/promptInjection.test.ts` | 1 | Adversarial encounter note tries to make the model emit a citation that isn't in the snapshot. Verifier rejects with `source-record-not-in-snapshot`. |
| `archetypes/crossPatient.test.ts` | 1 | Snapshot endpoint returns 403 when a principal asks for a chart they don't own. **Zero tokens spent** (rejection happens at the proxy, before the agent runs). |
| `archetypes/externalCare.test.ts` | 5 | UC4 outside-care scenarios: recent ED visit imported via CCDA, patient with no external records, malformed CCDA emits a `gap`. |
| `archetypes/prescriptionChange.test.ts` | 7 | UC3 medication-change cases: lisinopril started 6 weeks ago (matches `USERS.md` UC3), med with no documented indication, med prescribed by an unknown user. |
| `archetypes/adversarialReminderAndStatement.test.ts` | 4 | §4.6 reminder-claim with wrong `dueStatus`, medication-statement claim citing a fabricated `MedicationStatement` id — both rejected. |
| `archetypes/supervisor-routing.test.ts` | 1 | Supervisor picks from the closed-enum handoff set; `reason` field is non-empty; iteration cap is never exceeded for the standard briefing path. |
| `archetypes/cap-hit.test.ts` | 1 | W1 regression: supervisor at iteration cap produces a verifiable response via forced synthesize. |
| `archetypes/multi-turn-followup.test.ts` | 1 | Prior-turn context window (K=5) replays user text + `{citations, facts}` without prose; synthesizer cites a prior-turn SourceReference. |
| `archetypes/hiddenDataExtraction.test.ts` | 1 | Prompt attempts to extract data about a different patient via follow-up. Verifier rejects; cross-patient claim logged to `unverified_claims`. |
| `archetypes/crossConversation.test.ts` | 1 | Data from a different conversation's `thread_id` does not leak into the current turn's briefing. |
| `archetypes/malformedModelOutput.test.ts` | 3 | Three malformed synthesizer outputs (missing `sourceReferences`, extra unknown field, wrong enum value); verifier rejects all three. |
| `archetypes/authTier.test.ts` | 1 | Non-clinician principal (receptionist role) cannot invoke the briefing endpoint; 403 returned before the graph runs. |

### W1 — lab/vitals trend (6 tests across 3 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `lab-trends/trendUp.test.ts` | 2 | A1c trend up on the `diabetic_uncontrolled` archetype. Faithful claim accepted; adversarial (fabricated value, wrong date, hallucinated record id) rejected. |
| `lab-trends/trendStable.test.ts` | 2 | A1c trend stable on the `diabetic` archetype, same accept/reject pattern. |
| `lab-trends/noHistory.test.ts` | 2 | `healthy_adult` — no lab history available; agent emits a `gap` claim, never a fabricated trend. |

### W1 — morning-prep precompute (2 tests across 2 files)

| Case file | Tests | What it pins |
| --- | ---: | --- |
| `morning-prep/morningPrepFlagging.test.ts` | 1 | 20-patient day for an opted-in practitioner. Each appointment produces a deterministic `flags` row keyed by `(practitioner_uuid, appointment_id)`. |
| `morning-prep/idempotency.test.ts` | 1 | Re-running the morning-prep cron over the same `(practitioner_uuid, date)` is a no-op. The settings table's `morning_prep_enabled = FALSE` default means a non-opted-in clinician produces zero rows, zero tokens, zero log lines. |

## LangSmith datasets (nightly experiment layer)

The Vitest gate stubs the model. The nightly experiment runs the real
Anthropic synthesizer (+ OpenAI embeddings + Cohere rerank + Pinecone
for W2 suites) against pinned ground truth on these datasets:

| Dataset | Bound to | Defined in | Purpose |
| --- | --- | --- | --- |
| `clinical-copilot-briefing-graph-v2` | W1 archetype mix, UC3/4/5 paths | `agent/evals/runners/briefingGraphSuite.ts` | Real-model check on the default-briefing + follow-up paths. Bumped from `-v3` to `-v2` on W2 `SourceReference` migration. |
| `clinical-copilot-conversational-graph-v5` | W2 supervisor routing, retrievers, verification | `agent/evals/runners/conversationalGraphSuite.ts` | Real-model check on the W2 supervisor loop: document-evidence retriever, guidelines retriever, verification gate, cap-hit path, refusal path. |
| `clinical-copilot-document-extraction-v1` | W2 pipeline — lab PDF, intake form, degraded, adversarial | `agent/evals/runners/documentExtractionSuite.ts` | Real-model (vision) check on the ingestion pipeline end-to-end: schema validity, confidence signals, patient match, idempotency. |

The W1 lab-trend and morning-prep datasets (`clinical-copilot-uc2-trend-v1`,
`clinical-copilot-uc5-morning-prep-v1`) are covered by the briefing-graph
suite in the nightly experiment; the per-MR Vitest gate still runs
dedicated lab-trends and morning-prep case files for deterministic coverage.

**Run locally** (requires `LANGSMITH_API_KEY` + `ANTHROPIC_API_KEY` + W2 vendor keys):

```sh
cd agent
npm run evals:upload-dataset    # idempotent — no-op if dataset exists
npm run evals:experiment        # runs the real synthesizer against the dataset
```

**Public LangSmith share link:** _to be populated when the datasets are
made publicly viewable per the submission deliverable. After flipping
visibility to public in LangSmith → Settings → Datasets, add the share
URLs here._

## W2 dataset shares

| Dataset | Share link |
| --- | --- |
| `clinical-copilot-briefing-graph-v2` | _pending — user to flip visibility and paste link_ |
| `clinical-copilot-conversational-graph-v5` | _pending_ |
| `clinical-copilot-document-extraction-v1` | _pending_ |

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
