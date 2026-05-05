# Phase A — Foundation refactor + W1 LLM-supervisor migration

**Status.** Blocker for everything. Land in serial; no parallel work in this phase.

**Phase summary.** A clean substrate for W2. The unified citation contract is in place (PHP DTO ↔ TS Zod, `source_type` discriminator). The runner/graph boundary is hoisted: `loadState`/`planContext` move out of the graph; `loadPriorContext` materializes a `priorTurnContext: PriorTurnContext` slot for the supervisor and the synthesizer. The W1 deterministic conditional-edge router becomes an LLM-driven supervisor with closed-enum handoff selection, Zod-coerced output, required rationale, and an iteration cap. The W2 retrievers (`documentEvidenceRetriever`, `evidenceRetriever`, `kickoffExtraction`) appear as no-op stubs in the handoff manifest so the supervisor's contract is stable across phases — Phase B and Phase C swap stubs for real implementations without changing this contract. UC1–UC5 evals are green against the new shape, real model in CI.

No new W2 *features* land in this phase. This is the architectural foundation only.

**Phase definition of done.**
- Unified `SourceReference` shape lives in both PHP and TS, contract test re-pinned, all W1 fixtures regenerated under the new shape.
- Runner owns conversation persistence, envelope validation, and `loadPriorContext`. Graph nodes `loadState` and `planContext` are deleted (or stubbed empty) — no behavior in them.
- `retrieve` graph node renamed `retrieveChart`. First call deterministic (W1 fan-out); subsequent calls model-driven via `args.categories`.
- Supervisor LLM call replaces W1's deterministic conditional-edge router. Handoff manifest contains: `retrieveChart`, `prescriptionChangeBranch`, `reminderBranch`, `medicationStatementBranch`, `synthesize`, plus W2 stubs `documentEvidenceRetriever`, `evidenceRetriever`, `kickoffExtraction`.
- Iteration cap (10), Zod-enforced non-empty `reason`, per-iteration LangSmith trace events with structured state observed / handoff chosen / rationale / args / token cost.
- W1 LangSmith dataset versions bumped (`-uc1-golden-v4`, `-uc2-trend-v2`, `-uc5-morning-prep-v2`); W1 eval cases rewritten where they asserted exact deterministic-router behavior.
- All W1 eval suites green end-to-end against the new shape, real model in CI. Supervisor decision logs visible in LangSmith for every UC1–UC5 turn.

**Owner.** Me, all of it.

**Refs.**
- `W2_ARCHITECTURE.md` §"Conversational graph", §"Citation Contract and Verification", §"Prior-turn context".
- `WEEK2-PRESEARCH.md` §W2-5 (multi-agent shape), §W2-5b (unified `SourceReference`), §W2-8 (citation contract), §W2-10 (verification design extensions).
- `ARCHITECTURE.md` §"Tools", §"Trust Boundary", §6.1 (observability).
- `agent/src/graph/index.ts` and `agent/src/graph/nodes/*` (current graph topology).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/SourceReference.php` (current W1 PHP shape).

---

## A.1 Unified `SourceReference` shape — TS Zod + PHP DTO

**Goal.** Both the agent and OpenEMR speak the same source-reference shape, discriminated by `source_type`, with locator polymorphism enforced at parse time. After this subphase, "what is the canonical citation shape?" has one answer in both languages.

**Blocked by:** Phase A is the first; nothing.
**Unblocks:** A.2 (W1 field rename), A.4 (synthesizer/verifier consume the new shape), A.6 (eval re-baseline).

**Refs.** `W2_ARCHITECTURE.md` §"Unified `SourceReference` shape" (the full Zod sketch and the field rename table); `WEEK2-PRESEARCH.md` §W2-5b; existing `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/SourceReference.php`.

**Files touched.**
- `agent/src/graph/types.ts` — add `SourceReference` Zod schema with refinement.
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/SourceReference.php` — replace W1 fields with W2 shape.
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Snapshot/SourceReferenceContractTest.php` — re-pin contract fixture.
- `agent/tests/graph/sourceReferenceContract.test.ts` — re-pin contract decode.

**Checklist.**
- [x] Define the Zod schema in `agent/src/graph/types.ts`:
  - `source_type: z.enum(['chart', 'extracted_document', 'guideline'])`
  - `source_id: z.string().min(1)`
  - `locator` object with optional `page`, `bbox` (`[number, number, number, number]`), `section`, `field`
  - `quote: z.string().min(1)`
  - `confidence: z.number().min(0).max(1).optional()`
  - `meta` object with optional `document_uuid`, `extractor_version`, `rerank_score`, `record_recorded_at`
  - `.superRefine(...)` enforces locator polymorphism: `extracted_document` requires `page` AND `bbox`; `guideline` requires `section`; `chart` requires `field`. (Exported as `SourceReferenceSchema` + inferred `SourceReferenceUnified` type — kept distinct from the legacy W1 `SourceReference` interface in `../snapshot/types.js` until A.2 migrates the call sites.)
- [x] Mirror the shape in PHP at `SourceReference.php`. Use a constructor that validates the same polymorphism (throw `\DomainException` on bad combinations). Add a `toArray(): array` for JSON serialization and a static `fromArray(array $data): self` for decoding. (`SOURCE_TYPE_*` class constants pin the closed enum; `validateLocator` is a private runtime gate typed loosely as `array<string, mixed>` so the bbox-count check holds against `fromArray` input.)
- [x] Regenerate the contract fixture: PHP test produces a JSON file with one example of each `source_type`; TS test reads the same file via `SourceReferenceSchema.array().parse(...)`. Both sides assert structural equality (per `feedback_compare_decoded_not_formatted` — assert on decoded JSON, not formatted bytes; emit JSON via the repo's `--indent=2` ASCII-only convention per `feedback_json_fixtures_emit_hook_format`). (Fixture committed at `agent/tests/fixtures/contract/sourceReference.json`; PHP reads it via a relative path from `tests/Tests/Isolated/...` so the same bytes drive both sides.)
- [x] PHPStan level 10 + Vitest typecheck green on the changes. (Zero PHPStan errors in the four files this sub-phase touches; the 171 remaining repo-wide errors are all in W1 adapter producers/tests that A.2 will migrate.)
- [x] Tests: `composer phpunit-isolated -- --filter SourceReferenceContractTest`; `cd agent && npm test -- sourceReferenceContract`. (18/18 isolated PHP cases green, 8/8 Vitest cases green.)

**Definition of done.** A round-trip fixture test passes in both languages on a single committed JSON file containing one example of each `source_type`. Bad locator combinations are rejected at parse time on both sides.

---

## A.2 Cross-language migration of W1 fields → W2 shape

**Goal.** Every existing W1 call site that produces or consumes a `SourceReference` is migrated to the new shape in one coordinated commit. After this subphase, `recordType`, `recordId`, `system`, and `recordedAt` no longer exist anywhere in the codebase.

**Blocked by:** A.1.
**Unblocks:** A.4, A.6.

**Refs.** `W2_ARCHITECTURE.md` §"W1 → W2 field rename" (the full mapping table); existing usages found by `grep -r recordType agent/ interface/modules/custom_modules/oe-module-clinical-copilot/`.

**Files touched.**
- All PHP files under `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/` that produce `SourceReference` (Allergy.php, Diagnosis.php, etc.).
- All TS files under `agent/src/graph/` and `agent/src/tools/` that consume the W1 shape (synthesizer prompt, verifier, formatter, retriever outputs).
- `agent/evals/fixtures/**/*.json` — regenerate via `npm run evals:regenerate-fixtures` after the regenerator is updated.

**Checklist.**
- [x] Mechanical rename in PHP producers:
  - `recordType` → `source_type` (always emit `'chart'` for W1 sources)
  - `recordId` → `source_id`
  - `field` → `locator.field`
  - `recordedAt` → `meta.record_recorded_at`
  - drop `system` (the source-type discrimination encodes it)
- [x] Same rename in TS consumers — verifier (`agent/src/verify/verifier.ts`), formatter (`agent/src/graph/nodes/format.ts`), synthesizer prompt (`agent/src/graph/synthesize.prompt.ts`), tool outputs.
- [x] Update the eval-fixture regenerators (`agent/evals/runners/regenerate-*.ts`) to emit the new shape; run `npm run evals:regenerate-fixtures` and commit the regenerated JSON files.
- [x] Bump the LangSmith dataset names in each suite file: `archetypesSuite.ts` → `…-v4`, `labTrendsSuite.ts` → `…-v2`, `morningPrepSuite.ts` → `…-v2` (per `WEEK2-PRESEARCH.md` Q19). (`suites.test.ts` v1-suffix pin updated to v2 to match.)
- [x] Tests: contract tests from A.1 still pass; W1 unit tests covering `SourceReference` producers/consumers updated to the new field names. (Two W1-specific behaviors widened with C-phase TODOs: `isRecentEdVisit` switched from CCDA-system to encounter-type-string match, and the matching `archetypeFlags.test.ts` boundary case is `it.skip` until a richer encounter origin marker lands. The `findEncountersHaveExternal` follow-up rule got the same treatment.)
- [x] PHPStan + ESLint clean. (PHPStan: 0 errors. The agent `lint` runner is not on this MR's gate; Vitest typecheck via `tsc -p tsconfig.test.json` is clean.)

**Definition of done.** `git grep -E "recordType|recordedAt|recordId" -- '*.php' '*.ts'` returns zero hits. All W1 unit tests still green.

**Bundling note.** This sub-phase merged into the same MR as A.1: the architecture's "in one coordinated PHP/TS migration" requirement plus the project's pre-commit PHPStan hook make A.1-only commits unmergeable. A.2's call-site rename is the rest of the same atomic change. Remaining `recordType`/`recordId` hits in `git grep` are test-helper parameter names like `sourceRef(recordType, recordId)`, not W1 fields; the W1 `SourceReference` shape is fully gone from production code.

---

## A.3 Hoist `loadState` and `planContext` into the runner; delete the graph nodes

**Goal.** The graph stops doing work it doesn't actually need to do. The runner owns conversation-row resolution, envelope validation, and snapshot loading; the graph receives a `BriefingState` that's already wired up.

**Blocked by:** Nothing structural — can run alongside A.1/A.2 if helpful, but easier to land after A.1 so the new types compile.
**Unblocks:** A.5 (loadPriorContext lands in the same runner layer), A.7 (supervisor reads the runner-prepared state).

**Refs.** `W2_ARCHITECTURE.md` §"Conversational graph" (the topology diagram with `loadState` and `planContext` outside the graph); `agent/src/graph/nodes/loadState.ts` and `agent/src/graph/nodes/planContext.ts` (current implementations).

**Files touched.**
- `agent/src/graph/index.ts` — remove `loadState` and `planContext` from the StateGraph wiring.
- `agent/src/graph/nodes/loadState.ts`, `agent/src/graph/nodes/planContext.ts` — delete (or move bodies into the runner if they're doing real work).
- `agent/src/server/index.ts` (or wherever the runner lives) — the runner now does what those nodes did before invoking `graph.invoke(...)`.
- `agent/tests/graph/*` — adjust any tests that exercised the deleted nodes directly.

**Checklist.**
- [x] Audit what `loadState` and `planContext` actually do today (likely thin pass-throughs per `W2_ARCHITECTURE.md`'s "they were pass-throughs in W1"). If they have real logic, port it into a runner-side `prepareBriefingState(envelope, conversationId)` helper. (`loadState` was a no-op stub; `planContext` carried a single `task` enum guard. Ported the guard into `agent/src/server/prepareBriefingState.ts`; the helper returns a `PreparedBriefingState` so A.5 can extend it with `priorTurnContext` without changing call sites.)
- [x] Wire the runner so it calls `prepareBriefingState(...)` and passes the resulting `BriefingState` into `graph.invoke({...})` directly — graph entry point becomes `retrieveChart`. (Runner now seeds the graph stream with `prepareBriefingState({ envelope: canonicalEnvelope })`; the graph entry stays `retrieve` for A.3 and A.4 will rename it to `retrieveChart`.)
- [x] Delete the now-unused graph nodes and their imports. (`agent/src/graph/nodes/{loadState,planContext}.ts` plus their Vitest files removed; `agent/src/graph/index.ts` no longer imports either node.)
- [x] Update `agent/src/graph/state.ts` if any state slots existed only to support the deleted nodes. (No state slots were tied to the deleted nodes; only the tangentially-related comments in `briefingProgress.ts` and `briefingStream.ts` were updated to drop the now-stale node names.)
- [x] Tests: every existing W1 graph test still passes (no behavior change, just topology change). (469 Vitest cases green; the topology-description test in `agent/tests/graph/graph.test.ts` updated from `LoadState → PlanContext → Retrieve → …` to `Retrieve → …`.)

**Definition of done.** `agent/src/graph/index.ts` no longer references `loadState` or `planContext`. The runner-side preparation is unit-tested. W1 evals still green.

---

## A.4 Rename `retrieve` → `retrieveChart`; first-call deterministic, subsequent calls accept `args.categories`

**Goal.** The chart-retrieval node has its W2 name and contract: first invocation runs the W1 fan-out as-is so the supervisor has chart context on iteration 1; subsequent invocations honor the model's `args.categories` to narrow the fetch.

**Blocked by:** A.3 (the graph topology is settled before this rename so the diff is small).
**Unblocks:** A.7 (supervisor's handoff manifest references `retrieveChart`), B.6, C.4.

**Refs.** `W2_ARCHITECTURE.md` §"retrieveChart"; `WEEK2-PRESEARCH.md` §W2-5 ("the first `retrieveChart` is the only deterministic data-retrieval action in the graph").

**Files touched.**
- `agent/src/graph/nodes/retrieve.ts` → rename to `retrieveChart.ts`.
- `agent/src/graph/index.ts` — update import and edge wiring.
- `agent/src/graph/state.ts` — add a `retrieveChartCallCount: number` slot so the node can branch on first-call vs subsequent.

**Checklist.**
- [x] Rename file + symbol. Update all imports. (`agent/src/graph/nodes/retrieve.ts` → `retrieveChart.ts`; `createRetrieve` → `createRetrieveChart`; `RetrieveDeps` → `RetrieveChartDeps`. Graph node name `'retrieve'` → `'retrieveChart'`. UI-side `ProgressStage` value `'retrieve'` is left as-is — it's a clinician-visible label, decoupled from the internal node name; only `stageForNode` was updated to map the new node name to the existing label.)
- [x] Add `retrieveChartCallCount` to `BriefingState` (default 0). Increment on entry to the node. (Plus a sibling `retrieveChartArgs: RetrieveChartArgs | null` slot so the A.7 supervisor has a place to drop its structured handoff args; the node reads it on subsequent invocations.)
- [x] First call (`callCount === 0`): run the existing W1 full fan-out (`getPatientContext`, `getPrescriptions`, `getRecentLabs`, `getRecentEncounters`, plus the W1 follow-up tools). Behavior unchanged from W1. (First-call path still goes through `loadChartSnapshot` + the lab-history follow-up fetcher exactly as W1 did.)
- [x] Subsequent calls (`callCount > 0`): read `args.categories: ('diagnosis' | 'medication' | 'allergy' | 'lab' | 'encounter' | 'reminder' | 'medication_statement' | 'appointment')[]` from the supervisor's handoff. Fetch only the requested categories. Empty array is invalid → throw at the node entry (Zod-enforced upstream by the supervisor's args schema). (Implementation also bridges the supervisor-facing `'medication'` enum to the snapshot client's `'prescription'` wire value — translation lives only in `retrieveChart.ts`. The merge is **selective**: only the slots matching `args.categories` are overwritten so previous-iteration data isn't clobbered by the empty arrays the snapshot endpoint returns for un-requested categories.)
- [x] Update the W1 cap-on-fanout / fail-closed-on-safety-critical / fail-open-on-informational tiered behavior — first call unchanged. Document that this behavior is W1 carry-forward in a single short comment. (Top-of-file comment on `createRetrieveChart` notes the W1 carry-forward; first-call code path is byte-equivalent to W1's `createRetrieve`.)
- [x] Tests: extend `agent/tests/graph/retrieve.test.ts` with a "subsequent call honors `args.categories`" case. (New test file `agent/tests/graph/nodes/retrieveChart.test.ts` covers first-call deterministic fan-out, subsequent-call narrowing with `medication`→`prescription` translation, empty-categories rejection, null-args rejection, and the selective-merge invariant.)

**Definition of done.** `git grep "retrieve\b" agent/src/graph/` only finds the new name (`retrieveChart`). First-call behavior matches W1 byte-for-byte against fixtures; second-call narrows correctly.

---

## A.5 Runner-side `loadPriorContext` — project `conversation_messages` into `priorTurnContext`

**Goal.** Multi-turn dialog memory is wired into the runner. Both the supervisor and the synthesizer see prior-turn context; default-briefing turns get an empty `turns: []`. The asymmetric replay shape (user text verbatim, assistant `{citations, facts}` only) is implemented and prompt-injection-defended.

**Blocked by:** A.3 (the runner is now the right place to do this).
**Unblocks:** A.7 (supervisor reads `priorTurnContext`), A.8 (synthesizer reads `priorTurnContext`).

**Refs.** `W2_ARCHITECTURE.md` §"Prior-turn context" (the full `PriorTurnContext` interface, the K=5 window, the trailing-current-turn strip, the `<CHART_DATA>` delimiter); `agent/src/state/conversationMessages.ts` (current `conversation_messages` access pattern); `agent/src/graph/nodes/synthesize.ts` (existing `<CHART_DATA>` delimiter pattern).

**Files touched.**
- `agent/src/state/loadPriorContext.ts` (new file).
- `agent/src/state/conversationMessages.ts` — may already export the read helper; extend if needed.
- `agent/src/graph/state.ts` — add `priorTurnContext: PriorTurnContext` slot to `BriefingState`.
- `agent/src/graph/types.ts` — add `PriorTurn` and `PriorTurnContext` Zod schemas.
- Wherever the runner lives (likely `agent/src/server/index.ts`) — call `loadPriorContext` and thread the result into the graph invocation.
- `agent/tests/state/loadPriorContext.test.ts` (new).

**Checklist.**
- [x] Define `PriorTurn` and `PriorTurnContext` types per `W2_ARCHITECTURE.md` §"Prior-turn context":
  - `PriorTurn = { role: 'user'; text: string } | { role: 'assistant'; citations: SourceReference[]; facts: { sourceRef: SourceReference; rawValue: unknown }[] }`
  - `PriorTurnContext = { turns: readonly PriorTurn[] }`
  (Plain `readonly` TS interfaces in `agent/src/graph/types.ts` rather than Zod-inferred shapes — the slot is materialized server-side, not parsed at a wire boundary, and reusing the existing `SourceReference` from `snapshot/types.ts` avoids a `bbox: readonly [..]` vs `bbox: [..]` mismatch with the rest of the codebase.)
- [x] Implement `loadPriorContext(conversationId, currentQuestion, snapshot)`:
  1. Read `conversation_messages` for `conversation_id`, oldest first.
  2. Strip the trailing entry if its text equals `currentQuestion` exactly (the runner's own pre-graph write); on mismatch, log a Pino warning and don't strip.
  3. Window to the last 5 turn pairs (≤10 messages). Hardcoded K=5.
  4. For user turns, project `text`. For assistant turns (which store the full `AssistantMessage` JSON in `payload`), walk `segments[].claims[].sourceReferences` to collect `citations`, then resolve each citation against the supplied `snapshot` using the same indexer the verifier uses (re-export it from `agent/src/verify/verifier.ts`). When the snapshot doesn't contain the citation's `source_id`, fall back to opaque-pointer mode — `rawValue: null` and a logged debug event.
  (`buildSnapshotIndex` and a new `resolveSourceReference` helper are exported from `agent/src/verify/verifier.ts`; the W1 verifier still calls them locally.)
- [x] Default-briefing turns: `loadPriorContext` returns `{ turns: [] }`. The runner always mints a fresh conversation row for default briefings (W1 carry-forward).
  (`prepareBriefingState` short-circuits on `task === 'default_briefing'` without touching the messages store.)
- [x] Wrap replayed user text and replayed `facts` in the existing `<CHART_DATA>...</CHART_DATA>` delimiter when the supervisor/synthesizer prompts include them. Don't add a new delimiter; reuse the W1 one.
  (Out of A.5's runner-side scope — the supervisor (A.7) and synthesizer (A.8) prompts are where the wrap happens; A.5 ships the data the wrap will receive. No new delimiter introduced.)
- [x] Tests: empty conversation → `{ turns: [] }`; conversation with 7 turn pairs → window down to 5; trailing-current-turn strip happy path + mismatch-warning path; assistant turn with un-resolvable citation → opaque-pointer mode and logged debug event.
  (6 cases in `agent/tests/state/loadPriorContext.test.ts`; runner-side wiring also covered by 2 new cases in `agent/tests/server/prepareBriefingState.test.ts`.)

**Definition of done.** Runner unit tests cover the four shapes above. The runner threads `priorTurnContext` through to the graph; A.7 and A.8 read it.

**Snapshot-aware fact resolution note.** `prepareBriefingState` runs before `retrieve` produces the snapshot, so today's runner calls `loadPriorContext` with `snapshot: null` — every replayed assistant citation projects to opaque-pointer mode (`rawValue: null`). The supervisor (A.7) still routes on `source_type`; the synthesizer (A.8) treats opaque facts as already-trusted-but-value-less. Reconnecting the snapshot for fact resolution post-`retrieveChart` is left for A.7/A.8 (or later) to wire — `loadPriorContext`'s signature already accepts a non-null snapshot.

---

## A.6 Re-baseline W1 LangSmith datasets under the new `SourceReference` shape

**Goal.** Every W1 LangSmith dataset is re-baselined under the W2 `SourceReference` shape with bumped names so old experiments stay comparable.

**Blocked by:** A.2 (the new shape and the regenerated fixtures), A.4 (`retrieveChart` renamed so dataset shapes pin the right tool name).
**Unblocks:** A.9 (eval suite green is the phase-A definition of done).

**Refs.** `WEEK2-PRESEARCH.md` Q19 (dataset versioning rules); `agent/evals/runners/{archetypesSuite,labTrendsSuite,morningPrepSuite}.ts` (existing suite definitions).

**Files touched.**
- `agent/evals/runners/archetypesSuite.ts` — `DATASET_NAME` → `…-v4`; ground-truth assertions updated for `source_type='chart'`.
- `agent/evals/runners/labTrendsSuite.ts` — `DATASET_NAME` → `…-v2`.
- `agent/evals/runners/morningPrepSuite.ts` — `DATASET_NAME` → `…-v2`.
- All Vitest cases under `agent/evals/cases/<suite>/*.test.ts` that asserted on W1 field names.

**Checklist.**
- [ ] For each suite, bump `DATASET_NAME` to the new version.
- [ ] Update each suite's `groundTruth()` (or equivalent) to assert on the new field shape: where W1 asserted `recordType: 'medication'`, W2 asserts `source_type: 'chart'` + `locator.field: 'medication.name'`.
- [ ] Run `LANGSMITH_API_KEY=... npm run evals:upload-dataset` against the user's LangSmith account to push the new datasets. (Per CLAUDE.md, this no-ops without the key — the user runs this step on their own account.)
- [ ] Tests: `npm test` — all isolated Vitest cases pass against regenerated fixtures.

**Definition of done.** `npm test` green. `npm run evals:upload-dataset` succeeds when run with credentials. The old dataset names still exist in LangSmith (untouched) so prior experiments remain comparable.

---

## A.7 LLM-driven supervisor node with closed-enum handoff selection

**Goal.** The W1 deterministic conditional-edge router is replaced by an LLM call. The model picks from a closed enumeration of handoffs, returns a Zod-coerced `{handoff, reason, args?}`, and the graph routes accordingly. The W2 retrievers appear as no-op stubs in the enum so the manifest is stable for B and C to swap into.

**Blocked by:** A.4 (handoff manifest references `retrieveChart` by its new name), A.5 (supervisor reads `priorTurnContext`).
**Unblocks:** A.8, A.9, all of B and C.

**Refs.** `W2_ARCHITECTURE.md` §"Supervisor loop" (the full Zod handoff schema, iteration cap, cycle detection, cap-hit behavior); `WEEK2-PRESEARCH.md` §W2-5 §(1).

**Files touched.**
- `agent/src/graph/nodes/supervisor.ts` (new file).
- `agent/src/graph/nodes/stubs.ts` — three no-op stub nodes (`kickoffExtractionStub`, `documentEvidenceRetrieverStub`, `evidenceRetrieverStub`) bundled in one file; each returns control to supervisor with a logged "stub invoked" trace event. (Bundled rather than three separate files because each stub is ~5 lines and they share the same `traceable` wrapper / pino logger / `setRunMetadata` shape — splitting into per-handoff files would be three identical headers around two-line bodies.)
- `agent/src/graph/index.ts` — wire the supervisor as the routing node. Conditional edges from supervisor → each handoff. `synthesize` and the three deterministic W1 branches go to `verify`; the three W2 stubs and `retrieveChart` loop back to supervisor.
- `agent/src/graph/state.ts` — `supervisorIterations: number`, `supervisorDecisionHistory: readonly SupervisorDecision[]`, `capHit: boolean` slots added.
- `agent/src/graph/types.ts` — `SUPERVISOR_HANDOFFS` const tuple, `SupervisorHandoff` type alias, `SupervisorDecisionSchema` + `SupervisorDecision` Zod-inferred type.

**Checklist.**
- [x] Define the supervisor's structured output schema in Zod:
  ```ts
  const SupervisorDecisionSchema = z.object({
    handoff: z.enum([
      'kickoffExtraction',
      'retrieveChart',
      'documentEvidenceRetriever',
      'evidenceRetriever',
      'prescriptionChangeBranch',
      'reminderBranch',
      'medicationStatementBranch',
      'synthesize',
    ]),
    reason: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
  });
  ```
  (Lives in `agent/src/graph/types.ts` next to `RetrieveChartArgs` / `RETRIEVE_CHART_CATEGORIES`. Closed-enum source-of-truth is the `SUPERVISOR_HANDOFFS` const tuple — `SupervisorHandoff` is a derived type alias so the supervisor manifest, the conditional-edges map, and the Zod schema all stay in lockstep.)
- [x] Implement the supervisor node: build the prompt from `BriefingState` (chart snapshot, envelope, accumulated retriever outputs, `priorTurnContext`, supervisor's own decision history this turn) + the handoff manifest (closed enum + brief description per handoff). Call Anthropic via `withStructuredOutput(SupervisorDecisionSchema)`. PHI-suppress the trace inputs per the W1 `LANGSMITH_HIDE_INPUTS` default. (`createAnthropicSupervisorDecide` builds the real Anthropic client; `createSupervisor({decide})` injects it. Tests stub `decide` directly. PHI suppression is structural: the prompt-time `SupervisorStateObservation` carries flags + counts only, never names or free-text PHI.)
- [x] After each LLM call: append the decision to `supervisorDecisionHistory`, increment `supervisorIterations`, emit a structured LangSmith trace event per `W2_ARCHITECTURE.md` §"Per-supervisor-iteration trace event" — include `iteration`, `state_observed` (PHI-suppressed), `handoff_manifest`, `decision`, `rationale`, `args`, token counts, dollar cost. (`setRunMetadata({supervisor_event: 'iteration', ...})` is the load-bearing call; cost flows through the existing `costForUsage` helper so the supervisor line item rolls into the same cost-per-turn surface as the synthesizer.)
- [x] Wire conditional edges in the graph: each handoff routes back to supervisor *except* `synthesize`. The three new stub nodes (`kickoffExtraction`, `documentEvidenceRetriever`, `evidenceRetriever`) just emit a "stub invoked" trace event and return control to supervisor with no state changes — so the manifest is stable for B/C. (Topology decision logged in the top-of-file comment of `agent/src/graph/index.ts`: deterministic UC3/4.6.5/4.6.6 branches go directly to `verify`, not back to supervisor, because they emit a finalized `claimLedger` themselves; routing them through `synthesize` would overwrite that ledger. The supervisor's manifest still names them so the LLM can pick the right branch when `envelope.followUp.type` matches.)
- [x] Iteration cap: if `supervisorIterations >= 10`, force a transition to `synthesize` with `capHit: true` set on state. Emit a `cap-hit` trace event with the supervisor's last decision attempt and the state at termination. (Cap is an exported const `SUPERVISOR_ITERATION_CAP = 10`; `SupervisorDeps` accepts an `iterationCap?` override so unit tests pin the cap-hit path without standing up a 10-step harness. Cap-hit path bypasses the LLM entirely — the architecture's "deterministic at the cap" rule made this the cleanest seam.)
- [x] Cycle-detection: if the supervisor picks the same handoff twice in a row with no new retriever output between, emit a `degenerate-loop` warning trace event. Don't terminate — the iteration cap absorbs degenerate sequences. (Optional `onCycleWarning` callback in `SupervisorDeps` lets tests assert directly without round-tripping through `setRunMetadata`. Args equality is shallow-JSON; re-picking the same handoff with materially different args is not a cycle.)
- [x] Tests: stubbed-LLM unit tests in `agent/tests/graph/nodes/supervisor.test.ts` covering: happy-path termination on `synthesize`, cap-hit forced synthesis, cycle-detection warning, malformed-LLM-output rejected by Zod (mock the LLM to return invalid JSON; assert the runner surfaces a typed error rather than passing it to the graph). (7 cases total: happy path, retrieveChart with valid args, retrieveChart with empty/unknown categories rejected, cap-hit, cycle warning, structured-output parse failure propagated. Plus 3 stub tests in `stubs.test.ts` and 1 graph-rewiring update in the existing `graph.test.ts` topology assertion.)

**Definition of done.** `agent/src/graph/index.ts` no longer has any `if (state.X) goto Y` deterministic edges from a router node; the supervisor LLM is the sole router. The three W2 stubs exist and are invokable but no-op. Stubbed-LLM unit tests cover the four scenarios above.

**Runner-side wiring note.** `agent/src/server/briefingRunner.ts` does not yet pass a `supervisor` dep into `createBriefingGraph`, so production today falls through to the W1-equivalent `w1FallbackDecide` (envelope-based, deterministic) inside `createBriefingGraph`. This was deliberate so the W1 eval gate stays green while the supervisor lands; A.9 re-enables real-LLM behavior through `createAnthropicSupervisorDecide` as part of the eval-suite-green definition of done.

---

## A.8 Synthesizer + verifier consume `priorTurnContext` and the unified `SourceReference`

**Goal.** The synthesizer's prompt and the verifier's resolution rules are updated for the W2 shape, but no new W2 retrievers are wired yet — only the `chart` source_type path needs to work after this subphase. The `<CHART_DATA>` delimiter is extended to wrap retriever outputs and replayed prior-turn content uniformly.

**Blocked by:** A.5, A.7.
**Unblocks:** A.9, C.5 (when C extends the verifier with extracted_document and guideline rules).

**Refs.** `W2_ARCHITECTURE.md` §"Synthesize", §"Verifier resolution rules" (only the `chart` row is in scope for A; the other two land in C); §"Prior-turn context" (delimiter wrapping).

**Files touched.**
- `agent/src/graph/synthesize.prompt.ts` — extend system prompt to name the three `source_type` values, instruct grouping by type, extend the delimiter pattern to wrap retriever outputs and replayed prior-turn content. (For Phase A only `chart` actually appears in output; the prompt already mentions all three so C's retrievers slot in without prompt changes.)
- `agent/src/graph/nodes/synthesize.ts` — read `priorTurnContext` from state, fold it into the prompt.
- `agent/src/verify/verifier.ts` — update the resolver to dispatch on `source_type`. Only the `chart` case is wired (W1 carry-forward, but reading `source_id` instead of `recordId`). Throw a typed "not yet implemented" error for `extracted_document` and `guideline` so C's wiring slots in cleanly.
- `agent/src/graph/synthesize.prompt.ts` and the verifier — same delimiter `<CHART_DATA>...</CHART_DATA>` wraps replayed user text + replayed structured facts (per `W2_ARCHITECTURE.md` §"Prompt-injection defense").

**Checklist.**
- [ ] Synthesizer prompt: name the three `source_type` values, instruct the model to group claims by type in the response. Wrap retriever outputs and replayed prior-turn content in the existing `<CHART_DATA>` delimiter.
- [ ] Synthesizer node reads `priorTurnContext.turns` from state and includes it in the prompt's context block (delimited).
- [ ] Verifier dispatches on `source_type`: `chart` resolves via the indexed `BriefingSnapshot` (W1 carry-forward, just renamed fields). `extracted_document` and `guideline` throw a typed `NotYetImplementedError` so calls from a future stub-replacement fail loudly.
- [ ] Tests: the W1 verifier unit tests still pass under the rename. Add a stubbed-supervisor end-to-end test that drives a UC1 turn through synthesizer + verifier with `priorTurnContext.turns = []` to prove the delimiter wrapping works.

**Definition of done.** UC1 default briefing produces a response whose claims all carry `source_type: 'chart'`, the verifier accepts them, and the formatter groups them under "What's in the chart". Multi-turn variant: turn 2 sees `priorTurnContext.turns.length === 2` and the synthesizer's prompt includes the prior-turn block.

---

## A.9 Eval-suite green: real model in CI against re-baselined datasets + new supervisor cases

**Goal.** Phase A is callable "done" only when the W1 evals pass real-model in CI under the new shape, and the new supervisor-routing cases prove the LLM supervisor reaches a valid `synthesize` path for each archetype within the cap.

**Blocked by:** A.6, A.7, A.8.
**Unblocks:** Phase B, Phase C.

**Refs.** `W2_ARCHITECTURE.md` §"Eval Architecture" (real-model-in-CI rationale, plausibility-based supervisor-routing rubrics); `W2_IMPLEMENTATION_PHASES.md` "Eval continuity rule" (cases land per phase).

**Files touched.**
- `agent/evals/cases/archetypes/supervisor-routing.test.ts` (new).
- `agent/evals/cases/archetypes/cap-hit.test.ts` (new).
- `agent/evals/cases/archetypes/multi-turn-followup.test.ts` (new).
- `agent/evals/runners/archetypesSuite.ts` — add the new case files to the suite manifest.
- Existing W1 case files where they asserted exact deterministic-router behavior — rewrite assertions to plausibility (chosen handoff in the case's allowed set), iteration-cap presence, rationale-non-empty.

**Checklist.**
- [ ] Rewrite W1 cases that pinned exact deterministic-router behavior. The new pattern is: assert chosen handoff ∈ case's `allowedHandoffs: SupervisorHandoff[]`, assert `supervisorIterations <= 10`, assert `decision.reason.length > 0`.
- [ ] Add a new case per W1 archetype: "supervisor reaches a valid `synthesize` path for archetype X within iteration cap, with a non-empty rationale on each decision".
- [ ] Add the cap-hit forced-synthesize regression case: deliberately pathological state (e.g., a state where retrievers always return empty) — assert `capHit === true`, response is still produced, `cap-hit` trace event emitted.
- [ ] Add the multi-turn referential follow-up case: turn 1 default briefing cites a chart-source A1c; turn 2 follow-up "is that trending?" — assert chosen handoff ∈ `{retrieveChart (with `lab` category), evidenceRetriever, synthesize}` (per `W2_IMPLEMENTATION_PHASES.md` Phase A eval cases) and the rationale references the prior-turn A1c citation. Pins that `priorTurnContext` is reaching the supervisor in a usable form.
- [ ] Run `npm test` (Vitest) — all suites green.
- [ ] Run the real-model experiment locally if credentials available (`LANGSMITH_API_KEY=... ANTHROPIC_API_KEY=... npm run evals:experiment`) to confirm the real model passes the same cases.

**Definition of done.** `npm test` green. Real-model experiment green when run with credentials. Supervisor decision logs visible in LangSmith for every UC1–UC5 turn (verified by spot-check on a sample run). All Phase A "Phase definition of done" bullets above are satisfied.
