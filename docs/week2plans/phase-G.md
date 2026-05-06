# Phase G — Polish: cost analysis, runbook, observability, README, demo video

**Status.** Parallel with Phase F. **Sunday Noon deadline gate.**

**Phase summary.** The W2 submission deliverables that aren't code: final demo video, cost analysis with real numbers, runbook entries for vendor outages, observability completeness pass, W1/W2 README polish, LangSmith dataset public-share-link. Most of these can be drafted earlier in the sprint (Phases D and E) with placeholder numbers and finalized in G when real eval-run data is available.

**Phase definition of done.**
- `docs/COST_ANALYSIS.md` updated for W2 with cost per stage at 100 / 1K / 10K / 100K user tiers, derived from real W2 eval-run data and a sample of conversational turns.
- `docs/RUNBOOK.md` includes all six new W2 entries (Spaces, Pinecone, Cohere, Anthropic vision, OpenAI embeddings, regression-injection drill).
- Observability completeness: zero PHI in vision-call inputs/outputs across all eval cases (W1 §6.1 phiTraceScanner extended to vision); cycle-detection metadata visible; cap-hit metadata visible; per-rubric pass-rate dashboards (LangSmith share link).
- `README.md` and `agent/README.md` updated for W2.
- Final polished demo video (3–5 minutes per the PDF) recorded and linked.
- LangSmith dataset publicly shared.
- Final regression-injection drill execution recorded.
- Architecture is interview-ready — the deployed app, the eval suite, and the docs all line up cohesively.

**Owner.** Engineer for cost-analysis structure, runbook drafts, observability extensions; user for the polished demo video, the final cost-numbers verification (running fresh evals against billing account), the LangSmith share-link visibility flip, and the final submission package.

**Refs.**
- `W2_ARCHITECTURE.md` §"Cost analysis", §"Observability and Cost", §"Runbook additions".
- `WEEK2-PRESEARCH.md` §W2-3 (cost & latency), §W2-11 (observability extensions), §W2-17 (deployment & ops), §W2-18 (README separation).
- `W2_IMPLEMENTATION_PHASES.md` Phase G bullets.

---

## G.1 `docs/COST_ANALYSIS.md` — W2 update

**Goal.** Cost analysis at 100 / 1K / 10K / 100K user tiers per stage (supervisor, embedding, Pinecone, rerank, synthesizer, vision, CI gate). Real numbers from W2 eval-run data and a sample of conversational turns. Methodology pinned to a specific commit so future re-runs are reproducible.

**Blocked by:** Phase E merged (so eval-run data is real and stable).
**Unblocks:** Sunday Final gate.

**Refs.** `W2_ARCHITECTURE.md` §"Cost analysis"; `WEEK2-PRESEARCH.md` §W2-3.

**Files touched.**
- `docs/COST_ANALYSIS.md`.

**Checklist.**
- [ ] **Methodology section:** how the numbers were derived (eval suite at commit `<sha>`, sampled conversational turns, vendor pricing snapshot date, exclusions). Reproducible.
- [ ] **Per-stage breakdown** at 100 / 1K / 10K / 100K user tiers:
  - Supervisor (Claude Sonnet 4.x): ~3-6 iterations per typical turn × short prompt + structured-output response. Token-count from real LangSmith traces.
  - Embedding (OpenAI `text-embedding-3-large`): index-time cost (one-time per corpus version) + per-query embed cost on each `evidenceRetriever` invocation.
  - Pinecone: serverless billing — stored vectors + reads. Tiny at MVP corpus size; scales with corpus growth.
  - Rerank (Cohere `rerank-v3.5`): per `evidenceRetriever` invocation.
  - Synthesizer (Claude Sonnet 4.x): per conversational turn (W1 carry-forward; numbers updated for any prompt-size growth from prior-turn context).
  - Vision (Claude Sonnet 4.x): per `attach_and_extract` call — pipeline graph, deterministic, one call per extraction.
  - CI gate: ~$2.50 per PR × PR cadence.
- [ ] **Hard caps surfaced:** per-document $1.00 cap (Q3); per-PR $5.00 CI cap; supervisor iteration cap (10) bounding worst-case.
- [ ] **Per-patient cost:** surfaces in `agent_request_log` for forensic rollups (no demo-budget cap).
- [ ] User runs a fresh eval suite to verify numbers reflect their actual billing-account usage; updates the file with their numbers.

**Definition of done.** `docs/COST_ANALYSIS.md` reflects real eval-run data. Methodology section is concrete enough to re-run.

---

## G.2 `docs/RUNBOOK.md` — W2 additions

**Goal.** All six new W2 runbook entries land: Spaces unreachable, Pinecone unreachable, Cohere unreachable (degraded mode), Anthropic vision rate-limited, OpenAI embeddings unreachable, regression-injection drill procedure.

**Blocked by:** Nothing structural; can land alongside D/E. Drafts encouraged early.
**Unblocks:** Sunday Final gate.

**Refs.** `W2_ARCHITECTURE.md` §"Runbook additions"; `WEEK2-PRESEARCH.md` §W2-14 (failure modes).

**Files touched.**
- `docs/RUNBOOK.md`.

**Checklist.**
- [ ] **Spaces unreachable:** failure mode → pipeline fails closed, conversation degrades. Recovery: check Spaces credentials, retry pipeline. Detection: Spaces-side 5xx in `agent/src/storage/spaces.ts` logs.
- [ ] **Pinecone unreachable:** `evidenceRetriever` fails open with explicit gap. Recovery: check `PINECONE_API_KEY` validity, retry conversation. Detection: Pinecone-side 5xx in agent traces; supervisor's `evidence-retrieval-unavailable` gap event.
- [ ] **Cohere unreachable:** degraded mode (no rerank). Convo still works. Recovery: optional. Detection: Cohere-side 5xx + `degraded-mode` trace event.
- [ ] **Anthropic vision rate-limited:** pipeline retries with backoff; second failure surfaces structured error. Recovery: monitor Anthropic spend dashboard.
- [ ] **OpenAI embeddings unreachable:** `evidenceRetriever` fail-open with explicit gap (same as Pinecone path; the embed step happens before the Pinecone query). Detection: OpenAI-side 5xx.
- [ ] **Regression-injection drill procedure:** copied from E.3's docs section if not already inline (the drill procedure lives here per `W2_ARCHITECTURE.md`).
- [ ] Each entry: failure mode, detection, mitigation steps, recovery, escalation path.

**Definition of done.** `docs/RUNBOOK.md` covers every vendor in the W2 stack with concrete recovery steps. Engineer + user sign off.

---

## G.3 Observability completeness pass

**Goal.** Verify the W2 observability surface is complete: zero PHI in vision-call inputs/outputs across all eval cases (W1 §6.1 phiTraceScanner extended to vision), cycle-detection metadata visible, cap-hit metadata visible, per-rubric pass-rate dashboards (LangSmith share link).

**Blocked by:** Phase E merged (eval suite at full coverage).
**Unblocks:** Sunday Final gate.

**Refs.** `W2_ARCHITECTURE.md` §"Observability and Cost"; `WEEK2-PRESEARCH.md` §W2-11.

**Files touched.**
- `agent/evals/cases/no-phi/vision-traces.test.ts` (extended in E.1; verify completeness here).
- `agent/src/observability/` — confirm cycle-detection and cap-hit emit the right shape.
- LangSmith UI — set up per-rubric dashboard.

**Checklist.**
- [ ] **PHI scan extended to vision:** the W1 `phiTraceScanner` test pattern extended to scan vision-call traces specifically. Run on all 50 cases. Zero hits expected (per architecture's `LANGSMITH_HIDE_INPUTS/OUTPUTS` defaults).
- [ ] **Cycle-detection metadata:** confirm a `degenerate-loop` warning event fires with the right shape on a fixture pathological state. Spot-check a recent LangSmith trace.
- [ ] **Cap-hit metadata:** confirm `cap-hit` event fires at iteration 10 with last-decision and state-at-termination. Spot-check.
- [ ] **Per-rubric pass-rate dashboard:** create a LangSmith share link with one chart per rubric × per category. Link from `docs/EVAL_RESULTS.md`.
- [ ] **Per-extraction metadata:** confirm pipeline traces include `doc_type`, `page_count`, `extractor_version`, vision token counts, schema warnings, patient-match score, confidence distribution histogram.

**Definition of done.** All five observability surfaces verified. Share link committed to `docs/EVAL_RESULTS.md`.

---

## G.4 README polish — top-level + agent

**Goal.** `README.md` and `agent/README.md` are interview-ready. Clear W1 baseline section + new "Week 2 — Multimodal Evidence Agent" section with setup steps, env vars, deployed link, demo video link.

**Blocked by:** D.5 (initial README pass), G.5 (final demo video URL).
**Unblocks:** Sunday Final gate.

**Refs.** `WEEK2-PRESEARCH.md` §W2-18; `W2_IMPLEMENTATION_PHASES.md` Phase G.

**Files touched.**
- `README.md`.
- `agent/README.md`.

**Checklist.**
- [ ] **Top-level `README.md`:** clear W1 baseline behavior section (untouched) + new "Week 2 — Multimodal Evidence Agent" section. Setup steps. Env vars (point to `agent/README.md`). Deployed link. Demo video link.
- [ ] **`agent/README.md`:** updated env-var table — `PINECONE_*`, `OPENAI_API_KEY`, `COHERE_API_KEY`, `SPACES_*`. Updated routes section — `/v1/agent/extract`, `/v1/agent/respond/stream`, `/v1/agent/respond`. W2 capability summary at top. Per `feedback_module_readmes` — keep this README.
- [ ] No content removed or moved that disturbs W1 instructions.

**Definition of done.** A reviewer can clone fresh, read top-level `README.md` + `agent/README.md`, and stand up the W2 system locally without further questions.

---

## G.5 Final polished demo video

**Goal.** 3–5 minute polished demo video per the PDF. Suggested script (per `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase G"):

1. Open Mrs. Patel's chart.
2. Upload her recent lab PDF.
3. Watch extraction stream.
4. Click on a cited extracted-document chip → bbox overlay shows.
5. Click on a guideline chip → section snippet popover.
6. Accept the extracted lab value → watch the chip transition to `chart` source type on the next turn.
7. Open eval results in CI / LangSmith share link.
8. Close.

**Blocked by:** Phase F merged (UI polish complete), G.3 (observability), G.4 (README so the URL points correctly).
**Unblocks:** Sunday Final gate.

**Owner.** User.

**Checklist.**
- [ ] User records the video using whatever capture tool. 3–5 minutes; polished, not raw.
- [ ] Video uploaded to a durable location (Loom, YouTube, Vimeo, or repo asset).
- [ ] URL added to `README.md` and `docs/EVAL_RESULTS.md`.

**Definition of done.** Video accessible via the URL in `README.md`. Engineer spot-checks the URL works.

---

## G.6 LangSmith dataset public-share-link

**Goal.** The LangSmith dataset visibility is flipped to public; share link committed for the submission deliverable.

**Blocked by:** Phase E merged (datasets are at final shape).
**Unblocks:** Sunday Final gate.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` Phase G; cuts list ("If Sunday Final is at risk: cut the LangSmith dataset public-share-link from G").

**Owner.** User.

**Checklist.**
- [ ] User flips visibility to public on each W2 dataset (per CLAUDE.md, the eval pipeline lives on the user's LangSmith account).
- [ ] Share links collected.
- [ ] Links committed to `docs/EVAL_RESULTS.md` under a "W2 dataset shares" section.

**Definition of done.** Reviewers can open the dataset from `docs/EVAL_RESULTS.md` without LangSmith credentials.

---

## G.7 Final regression-injection drill execution + recorded result

**Goal.** Execute the regression-injection drill once more before submission (per `W2_IMPLEMENTATION_PHASES.md` Phase G). Record the commit hash and CI pipeline URL in `RUNBOOK.md`.

**Blocked by:** E.3 (initial drill), G.2 (runbook entry exists).
**Unblocks:** Sunday Final gate.

**Refs.** `W2_ARCHITECTURE.md` §"Regression-injection drill"; `W2_IMPLEMENTATION_PHASES.md` §"Phase G — Polish" final-drill bullet.

**Files touched.**
- `docs/RUNBOOK.md` — drill log entries.

**Checklist.**
- [ ] Re-run the drill (same procedure as E.3): create `drill/regression-injection-N+1` branch, weaken verifier, push, verify CI red on the drill regression case, close PR without merging.
- [ ] Record drill iteration N+1 in `RUNBOOK.md` with date, commit hash, CI pipeline URL.
- [ ] Confirm latest CI run on `master` is green so the post-drill state is known good.

**Definition of done.** Drill log in `RUNBOOK.md` shows two executions (E.3 + G.7). Both verified to fail; both reverted. The drill is provably reproducible by a third party.

---

## G.8 Final submission package

**Goal.** Submission is interview-ready. The user has everything graders need in one place: deployed link, demo video, eval-results page, LangSmith share link, runbook, cost analysis.

**Blocked by:** All other Phase G subphases.
**Unblocks:** Sunday Final gate is satisfied.

**Owner.** User.

**Checklist.**
- [ ] Confirm `emr.biograph.dev` runs current `master` end-to-end.
- [ ] Confirm all links in `README.md` resolve.
- [ ] Confirm `docs/EVAL_RESULTS.md` has: per-suite case counts, latest run summary, LangSmith share links, video link.
- [ ] Confirm `docs/COST_ANALYSIS.md` reflects real numbers.
- [ ] Confirm `docs/RUNBOOK.md` covers all vendors + drill log.
- [ ] User submits the final package per the program's submission process.

**Definition of done.** Sunday Final gate satisfied. The architecture is interview-ready: deployed app reachable with W2 flow working end-to-end; final demo video uploaded; cost-and-latency report complete; LangSmith dataset publicly shared; READMEs updated.
