# Week 2 — Phase Plans

This directory holds the per-phase implementation breakdowns for the Week 2 Clinical Co-Pilot build. The phase shape, deadlines, and gating criteria are defined in `../W2_IMPLEMENTATION_PHASES.md`. Architectural decisions are in `../../W2_ARCHITECTURE.md`. Decision rationale (Q1–Q20) is in `../WEEK2-PRESEARCH.md`. The PDF source-of-truth requirements are in `../Week 2 - AgentForge Clinical Co-Pilot.pdf`.

Each `phase-<X>.md` file is the working checklist for that phase. Subphases are sized to be single-feature, user-story-shaped units of work: each one is small enough that a fresh agent (or a cheaper model) can pick it up cold given the doc plus the linked architecture references, and large enough that completing it produces a visible, testable deliverable.

## Phase order and parallelism

```
A  (foundation refactor — blocker)
↓
B ‖ C  (parallel: pipeline ‖ supervisor extensions + retrievers)
↓
D  (end-to-end thin slice — Tuesday MVP gate)
↓
E  (eval coverage + CI gate — Thursday Early Submission gate)
↓
F ‖ G  (parallel: Tier-3 promotion UI ‖ polish + cost + runbook + demo)
↓
END    (Sunday Final gate)
```

Within a phase, subphases are also ordered. Each subphase header notes its blockers explicitly (`Blocked by:` line) and which sibling subphases it unblocks (`Unblocks:` line) so the dependency graph is readable without reading the whole file.

## Phase docs

- [Phase A — Foundation refactor + W1 LLM-supervisor migration](phase-A.md) — blocker for everything
- [Phase B — Ingestion pipeline + Tier 1/2 persistence](phase-B.md) — parallel with C
- [Phase C — Conversational supervisor extensions + retrievers + USPSTF corpus](phase-C.md) — parallel with B
- [Phase D — End-to-end thin slice + MVP demo](phase-D.md) — Tuesday MVP gate
- [Phase E — Final eval coverage + real-model CI gate](phase-E.md) — Thursday Early Submission gate
- [Phase F — Tier-3 promotion UI + side-by-side PDF.js + inline accept/reject](phase-F.md) — parallel with G
- [Phase G — Polish: cost analysis, runbook, observability, README, demo video](phase-G.md) — parallel with F

## Subphase shape

Every subphase in every phase doc follows the same shape so a downstream agent knows exactly what to read:

```markdown
### A.3 Subphase title

**Goal.** One-paragraph user-story-shaped statement of what shipping this subphase makes possible.

**Blocked by:** A.1, A.2 (or "Phase A is the first; nothing.")
**Unblocks:** A.4, B.0, C.0

**Refs.** `W2_ARCHITECTURE.md` §"Conversational graph"; `WEEK2-PRESEARCH.md` §W2-5; `ARCHITECTURE.md` §"Tools".

**Files touched.** `agent/src/graph/nodes/retrieve.ts` (rename), `agent/src/graph/state.ts`, `agent/evals/runners/archetypesSuite.ts`.

**Checklist.**
- [ ] Concrete step 1 with enough detail that a cheaper model can implement it.
- [ ] Concrete step 2.
- [ ] ...
- [ ] Tests: which test files, which cases.
- [ ] Eval cases: which suite, what the new cases assert.

**Definition of done.** What you can demo or grep for once the box is checked.
```

The bar is: a fresh-context agent should be able to read one subphase plus the linked architecture references and ship the work without needing to read the rest of the codebase first.

## Reading order for a downstream agent

1. The subphase itself.
2. The phase doc's "Phase summary" + "Definition of done" sections (top of each `phase-<X>.md`).
3. Only the architecture sections referenced by the subphase's `Refs.` line — not the full architecture docs.
4. Only the files referenced by the subphase's `Files touched.` line — not the whole codebase.

If a subphase doesn't fit on a single page after this rule, it is too big and should be split.

## Updating these docs as work lands

Match the W1 `IMPLEMENTATION_PLAN.md` convention: flip checkboxes when the work is merged to `master`, add brief parenthetical follow-up notes after completed boxes that capture the actual choices made (file paths, library decisions, behavior surprises). Don't move subphases between phases — strike-through and add a redirect note instead.
