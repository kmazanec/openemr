# W2 Implementation — Phase Plan

Phase-level structure for the Week 2 Clinical Co-Pilot build. Granular bullets and sub-phases will land in `docs/week2plans/phase-N.md` once the phase plan is locked. This document defines phase boundaries, deliverables, dependencies, ownership, and the parallel-track human work.

The phase shape is grounded in `docs/WEEK2-PRESEARCH.md` (Q1–Q20 resolutions), `W2_ARCHITECTURE.md` (architecture decisions), and the Week 2 PDF's hard-gate deadlines (MVP Tuesday 11:59 PM, Early Submission Thursday 11:59 PM, Final Sunday Noon).

---

## Phase shape

```
Phase A — Foundation refactor + W1 LLM-supervisor migration   [BLOCKER for everything]
              ↓
        ┌─────┴─────┐
        ↓           ↓
   Phase B      Phase C        [parallel]
   Pipeline     Conversational supervisor
   + Tier 1/2   + retrievers + USPSTF corpus
        ↓           ↓
        └─────┬─────┘
              ↓
        Phase D — End-to-end thin slice + MVP demo   [Tuesday MVP gate]
              ↓
        Phase E — Final eval coverage + real-model CI gate    [Thursday Early Submission gate]
              ↓
        ┌─────┴─────┐
        ↓           ↓
   Phase F      Phase G        [parallel]
   Tier-3 UI    Polish: cost analysis, runbook,
   + PDF.js     observability, README, demo video
        ↓           ↓
        └─────┬─────┘
              ↓
              END   [Sunday Final gate]
```

**Eval continuity rule.** Each phase ships the eval cases that prove its surface lands. Phase E is reduced to *final wiring and CI hardening plus the cases that genuinely need the full integrated system*, not "build all 50 cases at the end." The 50-case suite reaches its full target by accumulation across phases A → D, with E adding the final ~5–8 integration-only cases.

---

## Phase A — Foundation refactor + W1 LLM-supervisor migration

**Status:** Blocker for every later phase. Land in serial, no parallel work.

**Goal.** A clean substrate for W2 work. The unified citation contract is in place. The runner/graph boundary is hoisted. W1 surfaces are migrated to the LLM-driven supervisor pattern that W2 will extend. UC1–UC5 evals are green against the new shape. No new W2 *features* land in this phase; this is the architectural foundation.

**What lands:**
- Unified `SourceReference` shape (PHP DTO + TS Zod schema), with `source_type` discriminator and locator polymorphism enforced by Zod refinement. W1 fields renamed in coordinated cross-language migration. Contract test (PHP fixture ↔ TS decode) re-pinned.
- `loadState` and `planContext` hoisted out of the graph into the runner layer. Runner owns conversation persistence and envelope validation; graph keeps only work it actually does.
- Runner-side `loadPriorContext` reads `conversation_messages` for the current conversation, strips the trailing current-question append (the runner's own pre-graph write), windows to last K=5 turn pairs, and threads `priorTurnContext: PriorTurnContext` onto `BriefingState` as a new state slot. **User turns carry their text verbatim** (the only signal of the dialog thread that isn't recoverable from data — pronoun referents, narrative continuity, corrections). **Assistant turns carry `{citations, facts}` only — no prose, no segments.** Each prior assistant turn replays as the verified `SourceReference[]` from that turn plus the minimal raw-data slices each citation resolved to; replayed text-blob is not threaded through the model. Default-briefing turns get `{turns: []}` (the runner always mints a fresh conversation row). Both the supervisor and the synthesizer read `priorTurnContext`. Source-of-truth is the existing `conversation_messages.payload` (full `AssistantMessage` JSON); the runner projects `segments[].claims[].sourceReferences` into `PriorTurn.citations` without schema changes. Prior content is wrapped in the same `<CHART_DATA>` delimiter the synthesizer already uses for retriever outputs — prompt-injection defense extends to replayed user text and replayed structured facts uniformly.
- `retrieve` graph node renamed `retrieveChart` with the first-call-deterministic / subsequent-calls-model-driven split. The deterministic-first behavior matches W1's existing fan-out exactly.
- W1 deterministic conditional-edge router replaced by an LLM-driven supervisor with closed-enum handoff selection and Zod-coerced output. The W1 handoff manifest contains: `retrieveChart`, the existing UC3/UC4.6.5/UC4.6.6 deterministic branches, and `synthesize`. The W2 retrievers (`documentEvidenceRetriever`, `evidenceRetriever`, `kickoffExtraction`) are present as no-op stubs in the enum so the manifest is stable across phases — Phase B and Phase C swap the stubs for real implementations without changing the supervisor's contract.
- Iteration cap (10), required rationale (Zod-enforced non-empty string), per-iteration LangSmith trace events with structured state observed / handoff chosen / rationale / args / token cost.
- Full re-baseline of W1 LangSmith datasets with bumped versions (`-uc1-golden-v4`, `-uc2-trend-v2`, `-uc5-morning-prep-v2`).
- W1 eval cases rewritten where they asserted exact deterministic-router behavior — supervisor-routing assertions become plausibility-based (chosen handoff in the case's allowed set), iteration-cap assertions, rationale-non-empty assertions.

**Deliverable to call A done.** Existing W1 eval suite green end-to-end against the new shape (real model in CI), supervisor decision logs visible in LangSmith for every UC1–UC5 turn, contract tests passing on both sides.

**Eval cases that land in A:**
- All W1 cases re-baselined under the new shape.
- New W1 supervisor-routing cases proving the LLM supervisor reaches a valid `synthesize` path for each archetype within the iteration cap, with reasonable rationale.
- Cap-hit forced-synthesize regression case (deliberately pathological state where the supervisor would loop without the cap).
- Multi-turn referential follow-up case: turn 1 default briefing cites a chart-source A1c; turn 2 follow-up "is that trending?" — assert the supervisor's chosen handoff is in the allowed set `{retrieveChart (with `lab` category), evidenceRetriever, synthesize}` and the rationale references the prior-turn A1c citation. Pins that `priorTurnContext` is reaching the supervisor in a usable form. Allowed-set rather than single-pinned per the W2 plausibility-based routing-rubric pattern.

**Owner.** Me, all of it.

---

## Phase B — Ingestion pipeline + Tier 1/2 persistence

**Status:** Parallel with Phase C. Begin once Phase A is merged.

**Goal.** The ingestion pipeline produces structured, cited extraction artifacts from a lab PDF or intake form. Tier 1 (DocumentReference) and Tier 2 (`extraction_artifacts`) persistence works end-to-end. The pipeline is invokable from any of three triggers; the conversational supervisor's `kickoffExtraction` stub is replaced with a real call to it.

**What lands:**
- Ingestion pipeline as a separate compiled LangGraph app: `rasterize → vision → schemaValidate → patientMatch → persist → emitDeltas`.
- Strict schemas for `lab_pdf` and `intake_form` (Zod with `.passthrough()`, PHP DTOs for OpenEMR-side persistence). Per-field bbox + page + quote + self-reported confidence in extraction output.
- Real Anthropic Sonnet 4.x vision integration via the existing `@langchain/anthropic` SDK with `withStructuredOutput`.
- DigitalOcean Spaces integration: per-patient prefix for canonical document storage, transient prefix with 24h lifecycle for rasterized page images, single-call signed URLs for vision payload delivery.
- Idempotency via `(document_hash, extractor_version)` UNIQUE on `extraction_artifacts`.
- Patient-match logic comparing extracted demographics against chart, with refuse-on-mismatch path.
- Tier 1 + Tier 2 persistence: DocumentReference write through OpenEMR's existing FHIR endpoint, `extraction_artifacts` row at `pending_confirmation`.
- New OpenEMR-side controller + `public/snapshot/extract.php` endpoint (custom-DAO pattern matching the rest of the W1 module). Receives `(document_uuid, pid, doc_type, trigger_source)` from the agent service.
- `kickoffExtraction` supervisor handoff: replace Phase A's no-op stub with the real synchronous pipeline invocation. Pipeline progress streams over SSE so the panel renders "Extracting document…".
- Per-extraction LangSmith trace metadata: doc_type, page_count, extractor_version, vision token costs, schema-validation warnings, patient-match score, confidence distribution.

**Deliverable to call B done.** Upload a fixture lab PDF, see a populated `extraction_artifacts` row in agent Postgres with the strict schema, see a DocumentReference in OpenEMR pointing to the bytes in Spaces, see the supervisor's `kickoffExtraction` handoff produce the artifact end-to-end without manual intervention.

**Eval cases that land in B:**
- Pipeline — lab PDF extraction (8 cases): clean scans across the seeded archetypes; one with multi-panel results, one with low-quality scan that survives extraction.
- Pipeline — intake form extraction (8 cases): clean intake forms covering each archetype's demographics shape, including the demographics-delta detection (Q2b).
- Pipeline — degraded inputs (6 cases): smudged, rotated, blank, unrelated document, partial intake, OCR-grade-bad scan. Verifier rejects low-confidence claims; UI surfaces Gap chips.
- Pipeline — adversarial (4 cases): wrong-patient document refuse, prompt-injection inside scanned text ignored, oversized document hits the $1 cap, corrupted PDF bytes fail safely.

**Owner.** Me for code; you for Spaces bucket + IAM key setup (see "Parallel human work" below).

---

## Phase C — Conversational supervisor extensions + retrievers + USPSTF corpus

**Status:** Parallel with Phase B. Begin once Phase A is merged.

**Goal.** The LLM supervisor's W2 handoffs are real. The two new retrievers (`documentEvidenceRetriever`, `evidenceRetriever`) accept structured args from the supervisor and produce `SourceReference[]`. The USPSTF corpus is indexed in Pinecone with hybrid sparse-dense retrieval. Cohere rerank wired.

**What lands:**
- `documentEvidenceRetriever` retriever node: replace Phase A's no-op stub with a real query over `extraction_artifacts` (filtered by `pid`, `status`, `doc_types`, `lookback_days`, semantic relevance to the supervisor's `query`). Returns `ExtractedFactSnippet[]` with bbox + page + quote + field path. Per-call LangSmith metadata: query (hashed), filters, count returned, latency.
- `evidenceRetriever` retriever node: replace Phase A's no-op stub with hybrid retrieval over Pinecone + Cohere rerank. Pinecone client wired, BM25 sparse vectors via `pinecone-text`, Cohere `rerank-3` over Pinecone's top-20 → top-3.
- USPSTF corpus ingest: one-shot `npm run evals:reindex-corpus` script that reads curated USPSTF chunks from a versioned source (`agent/data/corpus/uspstf/`), embeds via OpenAI `text-embedding-3-large`, upserts to Pinecone with metadata `{publication, year, section, url, license_tier}`, namespace `guidelines-v1`. Idempotent re-runs.
- Synthesizer prompt extended to handle three source types and to wrap retriever outputs in delimited tags so embedded instructions inside any source can't smuggle prompt-injection.
- Verifier extended with per-`source_type` resolution rules: chart claim resolution unchanged from W1; extracted-document claim resolution checks bbox + page + quote against the recorded extraction; guideline claim resolution checks chunk-id-in-this-turn + quote substring match.
- Hard stops on extraction confidence (Q14): combined signal (self-reported + schema warnings + partial patient-match), 0.7 starting threshold pinned in `agent/src/verify/confidenceThresholds.ts`. Fact-level rejection by default; allergy exception escalates to category-level fail-closed.
- Format node groups claims by `source_type` for the panel UI: "What's in the chart" / "From documents" / "Evidence" sections.

**Deliverable to call C done.** Ask the agent a clinical question against a seeded archetype, see the supervisor's iterations in LangSmith, see the supervisor invoke `evidenceRetriever` with a model-picked query, see USPSTF chunks returned with rerank scores, see a guideline claim cited in the synthesizer's output, see the verifier resolve the claim against the retriever's output.

**Eval cases that land in C:**
- Document-evidence retriever (4 cases): per-patient retrieval with known artifact set + known query → top-k matches, bboxes preserved through verifier.
- Guidelines retriever / RAG (4 cases): hybrid sparse+dense+rerank — relevant query returns expected USPSTF chunk; out-of-scope query returns no spurious hits; multi-source query (when more than one source is in the corpus, dimensionally bounded by USPSTF-only at MVP).
- Conversational graph — verification (4 cases): per-`source_type` rules — chart claim accept/reject, extracted_document claim with fabricated bbox rejected, guideline claim citing chunk not in retriever output rejected.
- Conversational graph — supervisor routing extensions (additions to A's case set, not duplicating): supervisor invokes `documentEvidenceRetriever` when artifacts present; invokes `evidenceRetriever` when chart shows notable finding; invokes both when both apply.

**Owner.** Me for code; you for Pinecone, OpenAI, Cohere account setup + API keys (see "Parallel human work" below).

---

## Phase D — End-to-end thin slice + MVP demo

**Status:** Begin when both B and C are merged. Tuesday 11:59 PM Central deadline gate.

**Goal.** A vertical slice from upload to source-cited briefing, end-to-end, working locally and on the deployed app. Polish is *not* the goal — proof of the loop is. PDF spec: "Lab PDF and intake form ingestion working locally; first extraction and first evidence retrieval demo."

**What lands:**
- Full integration of B + C: panel upload → pipeline produces artifact → supervisor sees the artifact and invokes `documentEvidenceRetriever` → supervisor invokes `evidenceRetriever` for the question's clinical topic → synthesizer produces a draft + claim ledger citing all three source types → verifier resolves all citations → format groups by source type → panel renders.
- Panel UI rendering for Phase D is *minimal*: existing chat-thread shape extended to render the three source-type groupings. `[source]` chips per claim render as tooltips only (chart link-out behavior is W1 carry-forward; bbox overlay and section-snippet popover defer to Phase F).
- Streaming progress events from the pipeline via SSE so the panel renders "Extracting document…" → "Document evidence available, drafting briefing…" → final response.
- Deployed app on `emr.biograph.dev` updated with all of A + B + C + D. The MVP demo runs against deployed.
- README updated with the W1 / W2 separation per Q-not-numbered: top-level README points to W2 setup steps without disturbing W1's existing content.

**Deliverable to call D done.** Tuesday MVP gate satisfied: lab PDF and intake form ingestion working locally and on `emr.biograph.dev`; first extraction visible in the panel with citations; first evidence retrieval visible in the response with a USPSTF citation; supervisor's decisions visible in LangSmith.

**Eval cases that land in D:**
- End-to-end — Mrs. Patel scenario (3 cases): full flow chart + lab PDF + intake form → briefing groups facts by source_type, citations present per claim, response coherent.
- End-to-end — refusal (3 cases): cross-patient leakage attempt, hidden-data extraction (SSN), out-of-scope question — all produce `safe_refusal` with `no_phi_in_logs`.

**Owner.** Me for code; you for the MVP demo dry-run (no formal video yet — that's Thursday/Sunday).

---

## Phase E — Final eval coverage + real-model CI gate

**Status:** Begin when D is merged. Thursday 11:59 PM Central deadline gate. Per your direction, eval cases land continuously across A–D with their respective surface; E is the final wiring and the integration-only cases that need the full system.

**Goal.** The 50-case suite is at 50 cases, all passing, all running against the real model in CI. CI is PR-blocking. The regression-injection drill is documented and verified by deliberate weakening + revert.

**What lands:**
- Final ~5–8 eval cases that genuinely need the full integrated system: the integration cases that exercise the full supervisor → retriever → synthesizer → verifier loop with multiple retrievers per turn, the cap-hit cases that need a fully-stocked handoff manifest, and the cross-cutting `no_phi_in_logs` extension cases that scan vision-call traces specifically (extension of W1 §6.1 phiTraceScanner).
- PR-blocking CI gate wiring in GitLab: 50-case suite runs on every push to a merge candidate, fails the pipeline if any rubric category drops >5% from baseline or below pass threshold.
- CI hard cap at $5/PR via a pre-flight cost-check job.
- Per-rubric baseline file `agent/evals/baselines/document_extraction_v1.json` committed; rebaseline procedure documented.
- Vendor-outage detection: graceful "skip with warning" on Anthropic / OpenAI / Cohere / Pinecone outages so a vendor blip doesn't block PRs. Skipped cases are flagged on the PR but don't fail the gate.
- Regression-injection drill: documented procedure in `docs/RUNBOOK.md` with the specific weakening (e.g., relax bbox-match requirement in the verifier), executed once before submission, verified to make CI fail, then reverted.
- Deployed app on `emr.biograph.dev` updated with all of A + B + C + D + E.
- Demo video for Early Submission: rough recording of the Tuesday MVP flow, sufficient for the Thursday gate, not the polished version.

**Deliverable to call E done.** Thursday Early Submission gate satisfied: supervisor + 2 workers visible in LangSmith with logged handoffs, 50-case eval suite running green in CI on a deliberate weakening-then-revert (proves the gate catches regressions), deployed app reachable, rough demo video.

**Eval cases that land in E:**
- ~5–8 integration-only cases that require the full system.
- The deliberate-regression case fixture for the drill.

**Owner.** Me for code + drill execution; you for sign-off on the rough demo recording.

---

## Phase F — Tier-3 promotion UI + side-by-side PDF.js + inline accept/reject

**Status:** Parallel with Phase G. Begin when E is merged. Sunday Noon deadline gate.

**Goal.** The clinician-facing surface that turns the W2 demo from "the agent extracts and cites" into "the clinician reviews, accepts, and the chart is updated traceably." The PDF spec's "click-to-source UI for citation snippets, with a simple document preview" requirement satisfied at full polish.

**What lands:**
- PDF.js bundle (lazy-loaded, dynamic import on first click). Side-by-side layout in the panel: chat thread on the left, PDF viewer on the right. Multi-page pre-scrolled to the cited page; bbox highlight overlay on the cited region.
- Section-snippet popover for `guideline` chips: anchored popover with chunk text, section anchor, publication name, year, link out where available.
- `extracted_document` chip click → opens side-by-side pane; subsequent extracted-document clicks swap the document/page/bbox in place; clicking a non-extracted chip closes the pane.
- Inline accept/reject controls per extracted fact in the "From documents" section. Accept fires Tier-3 promotion: lab → `ObservationLabWriteService` writes `DiagnosticReport` + `Observation`; intake form → `lists` / `family_history` rows with `source_document_uuid`. Reject marks `extraction_artifacts.status = 'rejected'`.
- New `ObservationLabWriteService` PHP service. Idempotent on `(source_document_uuid, panel_code, collection_date)`. Fires `procedure_report.post_insert` event.
- Doctrine migration adds `source_document_uuid VARCHAR(36) NULL` columns on `lists`, `family_history`, `procedure_report`.
- Per-fact promotion fires its own `AgentDisclosedEvent` with `action='tier3_promotion'` for both regulatory and engineering audit trails.
- After promotion, the same fact transitions to a `chart` source-type chip on the next briefing turn.
- Demographics-delta inline controls: separate accept/reject per delta field; accepting writes through OpenEMR's standard demographics-update path with audit.
- Panel responsive fallback: below 1200px width, the side-by-side falls back to stacked layout (PDF below chat).

**Deliverable to call F done.** Click-to-source works for all three source types. A clinician can accept an extracted lab value and watch it transition from `extracted_document` to `chart` chip on the next turn. The round-trip story (extract → display → accept → chart) is demoable end-to-end.

**Eval cases that land in F:**
- Round-trip test (Q13) — isolated PHPUnit asserting value/unit/refrange/abnormal flag/`source_document_uuid` round-trip + idempotency.
- Render-test coverage for the panel template's PDF.js mount points + accept/reject anchors.

**Owner.** Me for code; you for review of the Tier-3 promotion UX.

---

## Phase G — Polish: cost analysis, runbook, observability, README, demo video

**Status:** Parallel with Phase F. Sunday Noon deadline gate. Most of these can be drafted earlier with placeholder numbers and finalized in G when real eval-run data is available.

**Goal.** The W2 submission deliverables that aren't code: the final demo video, the cost analysis with real numbers, the runbook entries for vendor outages, the observability completeness pass, the W1/W2 README separation polish.

**What lands:**
- `docs/COST_ANALYSIS.md` updated for W2: cost per stage (supervisor, embedding, Pinecone, rerank, synthesizer, vision, CI gate) at 100 / 1K / 10K / 100K user tiers. Real numbers from W2 eval runs and a sample of conversational turns. Methodology note pinned to a specific commit so future re-runs are reproducible.
- `docs/RUNBOOK.md` additions: Spaces unreachable, Pinecone unreachable, Cohere unreachable (degraded mode), Anthropic vision rate-limited, OpenAI embeddings unreachable, regression-injection drill procedure.
- Observability completeness: scan recent LangSmith traces (the W1 §6.1 scanRecentTraces test extension) confirms zero PHI in vision-call inputs/outputs across all eval cases. Cycle-detection metadata visible. Cap-hit metadata visible. Per-rubric pass-rate dashboards (LangSmith share link).
- README at repo root: clear W1 baseline behavior section + new "Week 2 — Multimodal Evidence Agent" section with setup steps, env vars, deployed link, demo video link.
- `agent/README.md` updated for W2: new env vars (`PINECONE_*`, `OPENAI_API_KEY`, `COHERE_API_KEY`, `SPACES_*`), new routes (`/v1/agent/extract`, etc.), W2 capability summary.
- Final polished demo video, 3–5 minutes per the PDF: document upload → extraction → evidence retrieval → citations with bbox overlay → eval results screen → observability traces.
- LangSmith dataset share link made public for the submission deliverable.
- Final regression-injection drill execution + revert + commit hash recorded in `RUNBOOK.md`.

**Deliverable to call G done.** Sunday Final gate satisfied: deployed app reachable with W2 flow working end-to-end; final demo video uploaded; cost-and-latency report complete; LangSmith dataset publicly shared; README/agent README updated; the architecture is interview-ready.

**Owner.** Me for the cost-analysis structure + runbook drafts + observability extensions; you for the polished demo video, the cost numbers verification, the LangSmith share-link visibility flip, and the final submission package.

---

## Parallel human work track

While I'm coding any phase, here's the sequenced list of human-only tasks. Each entry notes which phase it must be ready by — start anything you need at least one phase ahead.

**Required by Phase B:**
- DigitalOcean Spaces bucket creation: `openemr-documents` (or your chosen name). IAM key for OpenEMR (read+write on the bucket prefix); separate IAM key for the agent service (read-only on the transient prefix only). Lifecycle policy on the transient prefix: 24h auto-delete. Region selection (recommend NYC3 to match the Droplet).
- DO Spaces credentials populated in `/etc/openemr/.env` on the Droplet (the existing secrets-rotation procedure in `RUNBOOK.md` covers the shape).
- Anthropic billing review: confirm your account spend cap is high enough for ~50 cases × supervisor iterations × CI cadence. Recommend $200/mo cap as a comfortable ceiling for the W2 sprint window; review post-W2.

**Required by Phase C:**
- Pinecone account setup. Free tier or starter is fine for MVP corpus size (USPSTF only ~50–80 chunks). Get an API key. Confirm region selection; default `us-east-1` is fine.
- OpenAI account setup with embeddings access. Get an API key. No billing-cap action needed at our usage volume but worth setting one as belt-and-suspenders.
- Cohere account setup with `rerank-3` access. Get an API key. Their free trial credits are typically sufficient for the W2 sprint.
- All four keys (Pinecone, OpenAI, Cohere, plus Spaces from earlier) populated in `/etc/openemr/.env` on the Droplet.

**Required by Phase E:**
- GitLab CI variable population for the new keys (so the real-model CI gate can authenticate to all four vendors during PR runs). Recommend "masked, protected" attributes per GitLab's CI variable best practices.

**Required by Phase F:**
- Review the Tier-3 promotion UX before I code it — especially: where the accept/reject controls sit visually relative to each fact, whether you want a confirmation toast on accept, what happens to a fact's chip after accept (transition animation? immediate refresh? next-turn refresh?). Recommend reviewing a low-fi mockup before I implement.

**Required by Phase G:**
- Demo recording — final polished version (3–5 min per the PDF). Script suggestion: open Mrs. Patel's chart → upload her recent lab PDF → watch extraction stream → click on a cited extracted-document chip to show the bbox overlay → click on a guideline chip to show the section snippet → accept the extracted lab value → watch the chip transition to `chart` source type on next turn → open eval results in CI / LangSmith share link → close.
- Final cost-analysis numbers verification — the structure and methodology I'll provide, but the actual dollar tally is best done by you running a fresh eval suite against your billing account so the numbers reflect your actual usage.
- LangSmith dataset visibility flip to public for the share-link deliverable.

**Already done (per your note):**
- DO Droplet provisioned + the GitLab pipeline configured.

---

## Phase risks and explicit cuts if a deadline is at risk

If Tuesday MVP is at risk:
- Cut `documentEvidenceRetriever` from Phase C; ship `evidenceRetriever` only. Demo shows guideline citation, not yet document-fact citation. Tier-3 already deferred to Phase F.
- Cut SSE progress streaming in Phase B; pipeline runs synchronously without panel feedback.
- Cut the corpus-versioning per-source metadata (`license_tier` etc.); ship USPSTF chunks with bare `{section, url}` only.

If Thursday Early Submission is at risk:
- Cut the vendor-outage graceful-degradation logic from Phase E; CI just fails on outage.
- Cut some adversarial / degraded-input eval cases from Phase B's set, prioritizing happy-path coverage.

If Sunday Final is at risk:
- Cut demographics-delta inline controls from Phase F; surface deltas as informational chips only, no promotion UI.
- Cut the LangSmith dataset public-share-link from G; submit a private LangSmith snapshot with explicit reviewer-access instructions instead.

The first cuts to fire are intentionally narrow — none of them remove a load-bearing PDF requirement, all of them remove polish.

---

## Definition of done per milestone

**MVP (Tuesday 11:59 PM Central):** Phase D delivered. Lab PDF and intake form ingestion working locally and on `emr.biograph.dev`; first extraction with citations visible in the panel; first evidence retrieval visible in the response; supervisor decisions logged in LangSmith.

**Early Submission (Thursday 11:59 PM Central):** Phase E delivered. Supervisor + 2 workers (`documentEvidenceRetriever`, `evidenceRetriever`) with logged handoffs; 50-case eval suite green in CI; PR-blocking CI gate verified by deliberate-regression drill; deployed app reachable; rough demo video.

**Final (Sunday Noon Central):** Phases F + G delivered. Tier-3 promotion UI working (accept/reject + chart write-through); PDF.js bbox overlay + guideline section-snippet popover; cost analysis with real numbers; runbook updated; final polished demo video; LangSmith dataset publicly shared.
