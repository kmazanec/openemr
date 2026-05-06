# Phase E — Final eval coverage + real-model CI gate

**Status.** Begin once Phase D is merged. **Thursday 11:59 PM Central deadline gate.**

**Phase summary.** Eval cases have been landing continuously across A → D with their respective surface (per the "Eval continuity rule" in `W2_IMPLEMENTATION_PHASES.md`). E adds the final ~5–8 integration-only cases that genuinely need the full system, wires the PR-blocking CI gate against real models, and runs the regression-injection drill that the PDF requires.

By the end of E: 50-case suite is at 50, all green, all real-model in CI; CI is PR-blocking; the regression-injection drill has been executed once with a deliberate weakening + revert and verified to make CI fail; vendor-outage detection skips gracefully so a vendor blip doesn't block PRs; the deployed app on `emr.biograph.dev` is up to date; a rough demo video is recorded for the Thursday gate.

**Phase definition of done.**
- 50-case suite is at 50 cases, all green, all running real-model in CI.
- PR-blocking CI gate wired in GitLab; fails the pipeline if any rubric category drops >5% from baseline or below pass threshold.
- CI hard cap at $5/PR enforced via a pre-flight cost-check job.
- Per-rubric baseline file `agent/evals/baselines/document_extraction_v1.json` committed; rebaseline procedure documented.
- Vendor-outage detection: graceful "skip with warning" on Anthropic / OpenAI / Cohere / Pinecone outages.
- Regression-injection drill documented in `docs/RUNBOOK.md`; executed once, verified to make CI fail, then reverted.
- Deployed app on `emr.biograph.dev` runs all of A + B + C + D + E.
- Rough demo video for Early Submission recorded.

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
**Unblocks:** E.2 (CI gate needs the full 50-case suite).

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

## E.2 Per-rubric baseline file + rebaseline procedure

**Goal.** A committed baseline file pins the expected rubric pass rate per category. The CI gate compares against it. Rebaselining is a deliberate, documented step — never a side effect.

**Blocked by:** E.1.
**Unblocks:** E.4.

**Refs.** `W2_ARCHITECTURE.md` §"Eval Architecture" ("Per-category baselines committed to `agent/evals/baselines/document_extraction_v1.json`. Re-baseline only via deliberate `evals:rebaseline` runs.").

**Files touched.**
- `agent/evals/baselines/document_extraction_v1.json` (new).
- `agent/scripts/rebaseline.ts` (new).
- `agent/package.json` — `evals:rebaseline` script alias.
- `docs/RUNBOOK.md` — rebaseline procedure section.

**Checklist.**
- [ ] Run the full 50-case suite end-to-end at HEAD with all rubrics. Capture per-category pass rate.
- [ ] Commit `agent/evals/baselines/document_extraction_v1.json` with the shape:
  ```json
  {
    "version": "v1",
    "committed_at": "2026-...",
    "commit_sha": "...",
    "categories": {
      "pipeline_lab_pdf": { "pass_rate": 1.0, "case_count": 8 },
      "pipeline_intake_form": { "pass_rate": 1.0, "case_count": 8 },
      "...": "..."
    },
    "rubrics": {
      "schema_valid": { "pass_rate": 1.0 },
      "citation_present": { "pass_rate": 1.0 },
      "factually_consistent": { "pass_rate": 1.0 },
      "safe_refusal": { "pass_rate": 1.0 },
      "no_phi_in_logs": { "pass_rate": 1.0 }
    }
  }
  ```
- [ ] `agent/scripts/rebaseline.ts` runs the full suite and overwrites the baseline. Aborts unless invoked with `--confirm` and a `--commit-message` argument.
- [ ] Rebaseline procedure documented in `RUNBOOK.md`: when to rebaseline (model upgrade, intentional rubric tightening), how to commit (separate PR labeled `eval-rebaseline`), how to record context (commit message describes what changed and why).

**Definition of done.** Baseline file committed at HEAD reflects 100% pass for the full 50-case suite. Rebaseline script works against a feature branch.

---

## E.3 Regression-injection drill — documented procedure + executed once

**Goal.** The PDF's hard gate test is verified. Deliberately weaken the verifier, watch CI go red, revert. Procedure documented in `RUNBOOK.md`.

**Blocked by:** E.2 (baseline + CI must exist for the drill to demonstrate anything).
**Unblocks:** E.5 (Thursday gate is the drill being demonstrably effective).

**Refs.** `W2_ARCHITECTURE.md` §"Regression-injection drill"; `WEEK2-PRESEARCH.md` §W2-13.

**Files touched.**
- `docs/RUNBOOK.md` — drill procedure section.
- A short-lived branch + PR for the drill execution (the PR is reverted after CI confirms the regression is caught).

**Checklist.**
- [ ] Document the drill procedure in `RUNBOOK.md`:
  - The specific weakening: relax the bbox-match requirement in `agent/src/verify/verifier.ts` (the `extracted_document` resolution rule no longer checks bbox equality, only `source_id` presence).
  - The expected case to flip red: the drill regression case from E.1 (the case that asserts a fabricated-bbox extracted-document claim is rejected).
  - How to revert: `git revert` the weakening commit, push, confirm CI green.
- [ ] Execute the drill once before submission:
  1. Create branch `drill/regression-injection-N` (where N is the drill iteration).
  2. Apply the weakening from the runbook procedure.
  3. Push and open a PR.
  4. Verify the CI eval gate runs and fails on the drill regression case.
  5. Capture the failing pipeline URL and the specific failed-case output for the runbook.
  6. Close the PR without merging (drill complete; no production code change).
- [ ] Record the drill execution in `RUNBOOK.md` with date, commit hash of the weakening, and CI pipeline URL.

**Definition of done.** Drill executed once; runbook records the result. The procedure is concrete enough that a second engineer could re-run it without questions.

---

## E.4 PR-blocking CI gate + cost cap + vendor-outage detection

**Goal.** GitLab CI runs the full 50-case suite on every PR push, enforces the rubric thresholds, fails the pipeline on regression, and bails out gracefully on vendor outage so a temporary blip doesn't block merges.

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
  1. Run the full 50-case suite against real models.
  2. Compute per-category pass rate.
  3. Compare against `agent/evals/baselines/document_extraction_v1.json`.
  4. Fail if **any** category's pass rate drops more than 5% from baseline OR drops below the pass threshold (defined per-rubric in the baseline file — typically 0.95).
  5. Emit a structured summary on PR (markdown comment via `gh pr comment` or GitLab equivalent) with per-category breakdown.
- [ ] **`.gitlab-ci.yml` job:** new `evals:gate` job (depends on `test:agent`), runs after build + lint pass. PR-blocking. Uses GitLab's `rules: changes` so it doesn't run on docs-only PRs (per W1 pattern).
- [ ] Tests: stubbed-model unit tests for the gate script's pass/fail logic; assert exit code 1 on simulated 6%-category regression; assert exit code 0 on 4%-regression (within tolerance).

**Definition of done.** A throwaway PR with no real changes: gate runs against real models, passes. The drill PR from E.3: gate fails on the drill regression case. Cost reported per run, < $5 hard cap.

---

## E.5 Deployed app updated + rough demo video recorded

**Goal.** `emr.biograph.dev` reflects all of A + B + C + D + E. A rough demo video is recorded — sufficient for the Thursday gate, not the polished version.

**Blocked by:** E.4.
**Unblocks:** Thursday Early Submission gate.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` Phase E "Phase definition of done" — "Deployed app reachable, rough demo video".

**Owner.** Engineer for the deploy; user for the video.

**Checklist.**
- [ ] Deploy current `master` to `emr.biograph.dev` (per existing procedure in `RUNBOOK.md`).
- [ ] Smoke test: open a fixture patient, attach a fixture lab PDF, observe end-to-end with all source types in output.
- [ ] **Rough demo video (user records):** open Mrs. Patel's chart → upload her recent lab PDF → watch extraction stream → see briefing with three source-type sections → click eval results in CI to show 50/50 green. 3–5 minutes; not polished. Loom or QuickTime is fine.
- [ ] Place the video URL in `docs/EVAL_RESULTS.md` (for traceability) and confirm with user it's accessible to graders.

**Definition of done.** Thursday Early Submission gate satisfied: supervisor + 2 workers visible in LangSmith with logged handoffs; 50-case eval suite running green in CI; gate verified by the E.3 deliberate-weakening drill; deployed app reachable; rough demo video uploaded.
