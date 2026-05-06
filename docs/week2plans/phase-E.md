# Phase E — Final eval coverage + real-model CI gate

**Status.** Begin once Phase D is merged. **Thursday 11:59 PM Central deadline gate.**

**Phase summary.** Eval cases have been landing continuously across A → D with their respective surface (per the "Eval continuity rule" in `W2_IMPLEMENTATION_PHASES.md`). E adds the final integration-only cases that genuinely need the full system, wires the PR-blocking CI gate against real models, and runs the regression-injection drill that the PDF requires.

By the end of E: every suite's nightly experiment runs against real models; the unified per-rubric baseline is committed; CI is PR-blocking and fails when more than 5% of scored rubric × case cells flip across the whole eval suite; the regression-injection drill has been executed once with a deliberate weakening + revert and verified to make CI fail; vendor-outage detection skips gracefully so a vendor blip doesn't block PRs.

**Phase definition of done.**
- Every suite (`briefingGraph`, `conversationalGraph`, `endToEnd`, `documentExtraction`) runs its nightly experiment against real models with the boolean rubrics scored uniformly via `evaluators: [...RUBRICS]`.
- PR-blocking CI gate wired in GitLab. Compares the latest experiment's per-rubric scores against the unified baseline and fails when more than 5% of scored cells (rubric × case) flip across the whole suite.
- CI hard cap at $5/PR enforced via a pre-flight cost-check job.
- Unified eval baseline `agent/evals/baselines/eval-suite.json` committed (covers all four datasets); rebaseline procedure documented.
- Vendor-outage detection: graceful "skip with warning" on Anthropic / OpenAI / Cohere / Pinecone outages.
- Regression-injection drill documented in `docs/RUNBOOK.md`; executed once, verified to make CI fail, then reverted.

**Owner.** Engineer for code + drill execution; user for sign-off on the rough demo recording.

**Refs.**
- `W2_ARCHITECTURE.md` §"Eval Architecture" (real-model-in-CI rationale, boolean rubrics, plausibility-based supervisor-routing, regression-injection drill).
- `WEEK2-PRESEARCH.md` §W2-12 (eval gate — 50 cases, boolean rubrics), §W2-13 (CI gate — PR-blocking).
- `W2_IMPLEMENTATION_PHASES.md` Phase E bullets, "Phase risks and explicit cuts" (what to drop if Thursday slips).
- Existing CI surface — `.gitlab-ci.yml` and the `test:agent` job.

---

## E.0 Human-track prerequisites

**Goal.** GitLab CI variables for the new vendor keys are populated so the real-model CI gate can authenticate during PR runs.

**Blocked by:** Nothing.
**Unblocks:** E.4.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase E".

**Owner.** User.

**Checklist.**
- [x] GitLab CI variables populated: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COHERE_API_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_NAMESPACE`, `LANGSMITH_API_KEY`, all `SPACES_*`. **All marked "masked, protected"** per GitLab's CI variable best practices.
- [x] If a key needs to be different in CI vs prod (e.g., a separate Pinecone namespace for CI evals to avoid disturbing prod), document the namespace in `agent/README.md`.

**Definition of done.** Engineer triggers a CI run on a feature branch; vendor-using job authenticates without env-var errors.

---

## E.1 Final integration-only eval cases (~5–8)

**Goal.** The cases that genuinely need the full integrated system land. These are: cases that exercise the full supervisor → retriever → synthesizer → verifier loop with multiple retrievers per turn; cap-hit cases that need a fully-stocked handoff manifest; cross-cutting `no_phi_in_logs` extension cases that scan vision-call traces specifically.

**Blocked by:** Phase D merged (the full system runs end-to-end).
**Unblocks:** E.2 (the unified baseline can only be captured once every suite's case set is final).

**Refs.** `W2_IMPLEMENTATION_PHASES.md` Phase E "Eval cases that land in E"; `W2_ARCHITECTURE.md` §"Eval Architecture".

**Files touched.**
- `agent/evals/cases/conversational-graph/multi-retriever/multiRetriever.test.ts` (new).
- `agent/evals/cases/conversational-graph/cap-hit/capHit.test.ts` (new).
- `agent/evals/cases/no-phi/vision-traces.test.ts` (new) — extends the existing phiTraceScanner pattern.
- `agent/evals/runners/conversationalGraphSuite.ts` — extend dataset with `multi-retriever` and `cap-hit` rows; bump to `-v2`.
- `agent/evals/runners/conversationalGraphTarget.ts` — extend `ConversationalGraphCaseId` enum; extend `fixtureFor` and `reduceVerdict`.

**Checklist.**
- [x] **Multi-retriever turn cases (~3 cases):** turn that genuinely needs both `documentEvidenceRetriever` and `evidenceRetriever`. Assert supervisor invokes both within the cap; final response cites both source types; rationale on each decision is non-empty. (Landed as a new `multi-retriever` case group in `conversationalGraphSuite` — Vitest gate at `agent/evals/cases/conversational-graph/multi-retriever/multiRetriever.test.ts` exercises three orderings via `describe.each` against scripted vendors; the nightly experiment row runs the same scenario through the real graph + real Anthropic + Pinecone + Cohere via `runConversationalGraphCase('multi-retriever', …)`, projects accepted claims into `AgentRubricInput`, and the verdict reducer pins "verifier accepted ≥1 extracted_document AND ≥1 guideline claim".)
- [x] **Cap-hit cases (~2 cases):** state shaped so the supervisor would loop without the cap (e.g., retrievers always return empty). Assert `cap-hit` trace event emitted at iteration 10; forced-synthesize fires; response renders with appropriate Gap chips. (Landed as a new `cap-hit` case group in `conversationalGraphSuite` — Vitest gate at `agent/evals/cases/conversational-graph/cap-hit/capHit.test.ts` covers two scenarios (empty `documentEvidenceRetriever`, empty `evidenceRetriever`) with `iterationCap` overridden to 3 to stay under langgraph's `recursionLimit` of 25; the nightly experiment row uses the production cap (10) against a real model with no seeded artifacts and an off-topic question, projects to `AgentRubricInput`, and the verdict reducer pins "supervisor produced a usable response (graceful empty-acknowledgement OR cap-bound forced synthesize) without hard-stop or infinite loop".)
- [x] **`no_phi_in_logs` vision-trace extension (~2 cases):** scan recent LangSmith vision-call traces for any patient identifiers from the test fixture (per `WEEK2-PRESEARCH.md` §W2-15 — vision payloads are PHI; `LANGSMITH_HIDE_INPUTS/OUTPUTS` defaults should suppress them). (Kept Vitest-only because the case scans static fixtures, not a graph invocation. Landed at `agent/evals/cases/no-phi/vision-traces.test.ts` with `agent/evals/cases/no-phi/fixtures/{clean,leaky}-vision-trace.json`. Two-mode pattern mirrors `tests/observability/scanRecentTraces.test.ts`: always-on fixture mode + LangSmith live mode gated on both `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT`, filtered to runs whose name matches `/vision/i`. Reuses `scanForPhi`; canary list extended with the new fixture personas Whitaker/Reyes/Kowalski.)
- [x] **Drill regression case (~1 case):** the deliberate-regression fixture for the regression-injection drill (E.3). This test asserts the verifier's bbox-match requirement is enforced — when the drill weakens it, this case is the one that flips red. (Determined no new case is needed — `agent/evals/cases/conversational-graph/verification/verification.test.ts` "extracted-document claim with a fabricated bbox is rejected even when the artifact id resolves" already pins the bbox-match invariant. Drill rehearsal: temporarily commented out the bbox-equality check in `agent/src/verify/verifier.ts`; the existing case flips red as expected. The runbook's E.3 procedure can target that case + that line directly.)
- [x] All cases use real models in CI per architecture §"Real model in CI for all 50 cases". (The per-MR Vitest gate stubs the LLM seam — the deterministic-gate convention used uniformly across `conversationalGraph`, `endToEnd`, and `briefingGraph` Vitest cases. Real-model coverage of the multi-retriever and cap-hit invariants lives in the `conversationalGraphSuite` nightly LangSmith experiment alongside the document-evidence, guidelines, and verification rows; the five W2 boolean rubrics score every row uniformly via `evaluators: [...RUBRICS]` in `evaluate(...)`. Dataset name bumped to `clinical-copilot-conversational-graph-v2` because the case-group enum widened.)

**Definition of done.** Multi-retriever and cap-hit case groups land in `conversationalGraphSuite` alongside the existing document-evidence, guidelines, and verification groups, scored uniformly by the five boolean rubrics. Vision-trace `no_phi_in_logs` extension lands as a Vitest-only fixture+live-mode test under `agent/evals/cases/no-phi/`. The bbox-match drill target is the existing `verification.test.ts` case. `npm test` green.

---

## E.2 Unified eval baseline + rebaseline procedure

**Goal.** A single baseline file pins per-case, per-rubric booleans across every eval dataset. The CI gate (E.4) treats all four suites as one rubric universe: it sums every scored cell across `briefingGraph`, `conversationalGraph`, `endToEnd`, and `documentExtraction`, compares against the baseline, and fails the build when more than 5% of cells flip from `true` to `false`. Rebaselining is a deliberate, documented step — never a side effect.

**Blocked by:** E.1.
**Unblocks:** E.4.

**Refs.** `W2_ARCHITECTURE.md` §"Eval Architecture" — boolean rubrics, real-model nightly experiment, regression detection across the whole suite.

**Why one baseline, one tolerance.** The four suites are architecturally distinct (conversational graph vs document-extraction pipeline; default-briefing vs follow-up vs MVP scenario), but a regression that drops one rubric's pass rate across many cases — say `citation_present` flipping on 5 of 8 lab-PDF rows after a verifier change — is the same kind of failure regardless of which suite it lands in. A single tolerance budget sums every binary score across all four and catches the failure pattern uniformly. Per-suite tolerances would mask cross-cutting regressions.

**Tolerance shape.** Sum across every applicable (non-N/A) rubric × case cell in all four nightly experiments. With ~50 cases × 5 rubrics × N/A-aware skips, the scored-cell count is in the 150–200 range; a 5% tolerance fires when ~8–10 cells flip from baseline-pass to live-fail. Single-case flakes don't fail CI; uniform regressions on a single rubric across many cases do.

**Files touched.**
- `agent/evals/baselines/eval-suite.json` (new) — replaces the per-suite `document_extraction_v1.json`.
- `agent/evals/baselines/eval-suite.test.ts` (new) — replaces `document_extraction_v1.test.ts`. Walks all four datasets and pins manifest ↔ baseline correspondence.
- `agent/evals/baselines/document_extraction_v1.json` — delete (folded into the unified baseline).
- `agent/evals/baselines/document_extraction_v1.test.ts` — delete (replaced by the unified structural test).
- `agent/scripts/rebaseline.ts` (new) — pulls per-rubric scores from the latest LangSmith experiment for each suite, writes `eval-suite.json`. Aborts unless invoked with `--confirm` and a `--commit-message` argument.
- `agent/package.json` — `evals:rebaseline` script alias.
- `docs/RUNBOOK.md` — rebaseline procedure section.

**Checklist.**
- [ ] Run every suite's nightly experiment at HEAD via `npm run evals:experiment` (or wait for one nightly run after E.1 is merged). Capture per-case-per-rubric scores from LangSmith run-feedbacks.
- [ ] Commit `agent/evals/baselines/eval-suite.json` with the shape:
  ```json
  {
    "version": 1,
    "committedAt": "2026-...",
    "commitSha": "...",
    "datasets": {
      "clinical-copilot-briefing-graph-v1": {
        "cases": {
          "diabetic": {
            "citation_present": true,
            "factually_consistent": true,
            "no_phi_in_logs": true
          },
          "hypertensive": { "...": "..." }
        }
      },
      "clinical-copilot-conversational-graph-v2": { "cases": { "...": "..." } },
      "clinical-copilot-end-to-end-v1": { "cases": { "...": "..." } },
      "clinical-copilot-document-extraction-v1": { "cases": { "...": "..." } }
    }
  }
  ```
  Each case row's keys are the rubric names that scored on that case (N/A rubrics omitted, mirroring the evaluator's skip semantics). The values pin the expected boolean — typically `true` at baseline, but a row can baseline a deliberate `false` (e.g. a refusal case where `safe_refusal` is `true` but a non-applicable structural rubric isn't even present).
- [ ] `agent/scripts/rebaseline.ts` reads the latest LangSmith experiment's run-feedbacks for each dataset and writes the baseline file. Implementation note: use `langsmith.Client.listRuns({experimentName})` and follow each run's feedback edges; do not re-run the experiment locally. Aborts unless invoked with `--confirm` and a `--commit-message` argument that gets recorded in the commit body.
- [ ] `eval-suite.test.ts` pins three structural properties across all four datasets:
  1. Every dataset's case set on disk (manifest entries / suite EXAMPLES) is fully covered in the baseline (no untracked cases).
  2. Every baseline case row maps to a real case in its dataset (no orphans).
  3. The four `datasets.*` keys exactly match the four suite `DATASET_NAME` exports — so a future schema-bump rename forces both the suite file and the baseline in lockstep.
- [ ] Rebaseline procedure documented in `RUNBOOK.md`: when to rebaseline (model upgrade, intentional rubric tightening, deliberate suite expansion), how to invoke the script with `--confirm` + `--commit-message`, how to commit (separate PR labeled `eval-rebaseline`), how to record context (commit message describes what changed and why).
- [ ] Delete the legacy per-suite baseline (`document_extraction_v1.{json,test.ts}`). The unified file is the single source of truth.

**Definition of done.** `agent/evals/baselines/eval-suite.json` committed at HEAD covers every case across all four datasets with per-rubric booleans; the structural test enforces manifest ↔ baseline correspondence across all four; rebaseline script works against a feature branch; runbook section is concrete enough for a second engineer to re-run without questions; legacy per-suite baseline is gone.

---

## E.3 Regression-injection drill — documented procedure + executed once

**Goal.** The PDF's hard gate test is verified. Deliberately weaken the verifier, watch CI go red, revert. Procedure documented in `RUNBOOK.md`.

**Blocked by:** E.2 (baseline + CI must exist for the drill to demonstrate anything).
**Unblocks:** Phase E definition of done (the drill is the proof that the gate catches injected regressions).

**Refs.** `W2_ARCHITECTURE.md` §"Regression-injection drill"; `WEEK2-PRESEARCH.md` §W2-13.

**Files touched.**
- `docs/RUNBOOK.md` — drill procedure section.
- A short-lived branch + PR for the drill execution (the PR is reverted after CI confirms the regression is caught).

**Checklist.**
- [ ] Document the drill procedure in `RUNBOOK.md`:
  - The specific weakening: remove the bbox-equality check from `agent/src/verify/verifier.ts`'s `extracted_document` resolution rule — the line `if (!arraysEqual(ref.locator.bbox, snippet.bbox)) { return { ok: false, reason: REJECT_CONTENT }; }`. With this gone, a fabricated bbox no longer rejects.
  - The Vitest signal: `agent/evals/cases/conversational-graph/verification/verification.test.ts` "extracted-document claim with a fabricated bbox is rejected even when the artifact id resolves" flips red immediately (this is the deterministic gate that proves the weakening landed).
  - The CI eval-gate signal: across the live experiment runs, every `extracted_document` claim that previously rejected on a bbox mismatch now resolves, which flips multiple `factually_consistent` and `citation_present` cells across the conversational-graph and end-to-end datasets. Enough cells flip to push the regression rate over 5%, so `evals:gate` exits non-zero.
  - How to revert: `git revert` the weakening commit, push, confirm CI green.
- [ ] Execute the drill once before submission:
  1. Create branch `drill/regression-injection-N` (where N is the drill iteration).
  2. Apply the weakening from the runbook procedure.
  3. Push and open a PR.
  4. Verify both signals: Vitest gate red (`verification.test.ts` flips), CI eval-gate red (regression rate > 5%).
  5. Capture the failing pipeline URL, the Vitest failure, and the eval-gate cell-flip list for the runbook.
  6. Close the PR without merging (drill complete; no production code change).
- [ ] Record the drill execution in `RUNBOOK.md` with date, commit hash of the weakening, and CI pipeline URL.

**Definition of done.** Drill executed once; runbook records the result. The procedure is concrete enough that a second engineer could re-run it without questions.

---

## E.4 PR-blocking CI gate + cost cap + vendor-outage detection

**Goal.** GitLab CI runs every suite's experiment on every PR push, compares the per-rubric scores against the unified baseline, fails the pipeline when more than 5% of scored cells flip across the whole suite, and bails out gracefully on vendor outage so a temporary blip doesn't block merges.

**Blocked by:** E.0, E.2.
**Unblocks:** Phase E "Phase definition of done".

**Refs.** `W2_ARCHITECTURE.md` §"Real model in CI for all 50 cases" (per-PR cost ~$2.50, latency 3–5 minutes parallelized); `WEEK2-PRESEARCH.md` §W2-13 (CI gate spec).

**Files touched.**
- `.gitlab-ci.yml` — new `evals:gate` job with vendor env vars, cost-precheck, gate logic.
- `agent/scripts/check-cost-cap.ts` (new) — pre-flight cost estimate.
- `agent/scripts/eval-gate.ts` (new) — runs the suite against real models, compares against baseline, exits non-zero on regression.
- `agent/scripts/vendor-health-check.ts` (new) — checks each vendor's status before running cases; emits "skip with warning" on detected outage.

**Checklist.**
- [ ] **Cost precheck (`check-cost-cap.ts`):** estimate the run cost (case count × model + embedding + rerank cost) before launching. Fail the job with a typed error if estimate > $5 (the architecture's per-PR hard cap).
- [ ] **Vendor health check (`vendor-health-check.ts`):** GET each vendor's status endpoint (Anthropic status, OpenAI status, Cohere status, Pinecone status). If any vendor is down: emit a structured `vendor-outage` warning artifact, mark relevant cases as "skip with warning" in the run, continue with the rest. The skipped cases are flagged on the PR but don't fail the gate. Document in `RUNBOOK.md` what counts as "down".
- [ ] **Eval gate (`eval-gate.ts`):**
  1. Run every suite's experiment target against real models (one experiment per suite, posted to LangSmith with the PR's commit SHA).
  2. Pull per-rubric scores back from each experiment via `langsmith.Client.listRuns({experimentName})` + run-feedback edges.
  3. Compare against `agent/evals/baselines/eval-suite.json` (the unified per-case-per-rubric baseline from E.2).
  4. Compute the regression rate as `flippedCells / totalScoredCells`, where the sum spans every applicable rubric × case across all four datasets. Fail the gate when `flippedCells / totalScoredCells > 0.05`.
  5. Vendor-outage skips don't count toward `flippedCells` or `totalScoredCells` — they're surfaced separately on the PR comment.
  6. Emit a structured summary on PR (markdown comment via the GitLab API) with the regression rate, the list of flipped cells (`<dataset>::<caseId>::<rubric>`), and the vendor-outage skip list.
- [ ] **`.gitlab-ci.yml` job:** new `evals:gate` job (depends on `test:agent`), runs after build + lint pass. PR-blocking. Uses GitLab's `rules: changes` so it doesn't run on docs-only PRs (per W1 pattern).
- [ ] Tests: stubbed-model unit tests for the gate script's pass/fail logic. Inputs are synthetic baseline + live-experiment shapes (no real LangSmith call). Assert exit code 0 on a 4%-flip rate (within tolerance), exit code 1 on a 6%-flip rate (over tolerance), exit code 1 on any unrecognized live case ID (the live run drifted off the baseline's tracked-case set), exit code 1 on a baseline `true` cell that's missing from the live run (silent disappearance is a regression too).

**Definition of done.** A throwaway PR with no real changes: gate runs against real models, passes. The drill PR from E.3: gate fails because the drill flips enough verifier-resolution cells that `flippedCells / totalScoredCells > 0.05`. Cost reported per run, < $5 hard cap.
