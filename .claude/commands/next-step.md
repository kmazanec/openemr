---
description: Implement the next unchecked sub-phase in docs/IMPLEMENTATION_PLAN.md end-to-end (clarify → test → build → test → simplify).
---

# /next-step — Advance the Clinical Co-Pilot plan by one sub-phase

You are picking up the build of the Clinical Co-Pilot defined in
`ARCHITECTURE.md` and `USERS.md`. The living checklist is
`docs/IMPLEMENTATION_PLAN.md`. Your job is to implement **one sub-phase**
of that plan (e.g. §1.2, §2.1) end to end and leave the repo in a state
another contributor (or a future you) could pick up from cleanly.

A sub-phase is a `### N.M` heading like `### 1.2 Agent Postgres (state
store)` with one or more `- [ ]` checkboxes underneath it. Complete every
unchecked checkbox in the sub-phase in this invocation. Do not bleed into
the next sub-phase — when the current one's boxes are all flipped, stop
and report.

---

## 1. Orient

- Read `docs/IMPLEMENTATION_PLAN.md` in full. Identify the
  **lowest-numbered sub-phase (`### N.M`) that still has unchecked
  `- [ ]` items**. That is "the sub-phase." Every unchecked box under
  that heading is in scope for this invocation.
- Confirm the sub-phase isn't blocked by an earlier sub-phase that still
  has unchecked items. If it is, that earlier sub-phase is the target
  instead.
- Read the surrounding phase header and any "Why this phase first" / goal
  text — the framing matters for implementation choices.
- Skim `ARCHITECTURE.md` and `USERS.md` for the sections relevant to the
  sub-phase. If `docs/PRESEARCH.md` has rationale for the area you're
  touching, read that too.
- Run `git status` and `git log --oneline -10` so you understand what's
  in flight and what just shipped. Do not assume the working tree is
  clean.
- Use the Explore agent (or targeted `grep`/`Read`) to see what already
  exists in the area you're about to touch. **Do not duplicate code that
  already exists** — reuse it.

State the sub-phase you're picking up and list its unchecked checkboxes
verbatim before doing anything else, so the user can redirect if you
picked the wrong scope.

## 2. Plan

Think through how to implement the **whole sub-phase** before writing
code:

- What's the smallest set of changes that satisfies every checkbox in
  this sub-phase?
- What order should the checkboxes go in? Some are dependency-sequenced
  (the schema-init doc can't be written before the service is wired);
  others are independent (DTOs and adapters in §2.1/§2.2 can interleave).
  Pick an order that keeps the tree green between checkboxes.
- What files will you touch? What new files are needed?
- What's the test surface for each checkbox — unit, integration, eval,
  or PHPUnit isolated? You may share one test file across multiple
  checkboxes when they cover the same module.
- Does the sub-phase have implications for *later* sub-phases? Note them
  but don't pull them into this invocation.
- Are there decisions the plan doesn't pin down (naming, exact shape,
  library choice within an already-chosen ecosystem)?

If a decision genuinely needs the user, **ask before coding**. Bundle
*all* questions for the sub-phase into one message; don't drip-feed.
Acceptable questions: naming, API shape that affects callers,
library/version choices not already set in `package.json` or
`composer.json`. Not acceptable: things you can decide yourself by
reading existing code or the locked decisions table at the top of the
plan.

If everything's clear, list the checkbox order you'll work in and
proceed.

## 3. Tests first (when applicable)

Apply red-green-refactor **per checkbox**, not per sub-phase. For each
checkbox in the order picked above:

- For any code task, write or update tests **before** implementation
  where the test framework is already in place. If the checkbox itself
  is "add the test framework," skip this step for that one.
- TS/Node side: Vitest under `agent/tests/` or `agent/evals/`.
- PHP side: PHPUnit isolated under `tests/Tests/Isolated/...` when
  possible (no Docker required); PHPUnit services/api/unit under
  `tests/Tests/...` when the test legitimately needs the running stack.
- New tests must fail meaningfully before implementation (red), then pass
  after (green). Run them in the red state to confirm the failure mode is
  the one you expect.

If a particular checkbox is documentation, infra config, or a deliverable
doc, tests may not apply for that one — say so explicitly and move on.

## 4. Implement

Work the checkboxes in the order you picked. After each checkbox, the
tree should be green (tests, lint, typecheck) before you start the next.

- Smallest change per checkbox that makes its tests pass and satisfies
  the wording.
- Follow `CLAUDE.md`:
  - Strict types, native type declarations, `readonly` where appropriate
    (PHP).
  - PSR-3 logging context, never string-interpolated PHI.
  - No drive-by reformatting of untouched files.
  - No `mixed`, no inline `@var` casts to silence PHPStan, no new
    baseline entries.
- Don't add features, abstractions, or error handling that aren't
  required by the checkboxes in scope. Three similar lines beats a
  premature abstraction. If two checkboxes in this sub-phase happen to
  share a real abstraction once both are written, *that* is when to
  extract — not before.
- Comments only when the *why* is non-obvious — not what the code does.

## 5. Verify

Once **every checkbox in the sub-phase is implemented**, run the full
gate for what you touched:

- TS/Node: `cd agent && npm test` (or the narrower `vitest run <path>`
  while iterating, then a full run before declaring done).
- PHP isolated: `composer phpunit-isolated`.
- PHP in-Docker (if touched): from `docker/development-easy/`,
  `docker compose exec openemr /root/devtools <unit|api|services>-test`.
- Static analysis on touched PHP files:
  `composer phpstan` (full codebase — see `CLAUDE.md` "Always run on the
  full codebase"). Filter the output to your changed files.
- If you touched a Twig template with render-test coverage, run
  `composer update-twig-fixtures` and review the diff before committing.

If anything is red, fix it before continuing. Do not silence a real
failure to ship the sub-phase.

## 6. Simplify

This is the step the user explicitly asked for and the one that's easy
to skip. Don't. Sub-phase scope makes it more important: with several
checkboxes implemented in one pass, real abstractions and duplications
are easier to spot now than they were checkbox by checkbox.

Re-read everything you just wrote across the whole sub-phase and ask:

- **Duplication.** Does this repeat logic that already exists elsewhere
  in the repo? If yes, extract or call the existing implementation.
- **Reuse.** Is there an existing service, DTO, or helper that does most
  of what I just wrote? If yes, use it.
- **Shared functionality across the sub-phase.** Did two checkboxes end
  up with near-identical helpers, validation, fixtures, etc.? *Now* is
  when to extract — there are two real callers in front of you.
- **Dead code.** Anything I added that the test suite doesn't actually
  cover? Delete it.
- **Naming.** Will a future reader understand the names without
  conversation context? Rename if not.

If you make changes, re-run the gate from step 5.

## 7. Update the plan

- Flip **every** checkbox in this sub-phase in
  `docs/IMPLEMENTATION_PLAN.md` from `- [ ]` to `- [x]`. If a checkbox
  in scope was genuinely impossible to land in this invocation, leave it
  unchecked and explain in the report — do not flip a box you didn't
  finish.
- If you discovered something during the work that belongs in the plan
  (a new sub-task, a risk, a clarification of an adjacent item), add it
  in the right place. Don't move existing tasks between phases — strike
  through and add a note instead.

## 8. Report

End with a short message to the user covering:

- The sub-phase that was completed (one line) and the count of checkboxes
  flipped (e.g. "§1.2 Agent Postgres — 4/4").
- Files added/changed (paths only, no full diff).
- Test command(s) that pass.
- Anything they should know before the next `/next-step` (a question
  that came up, a decision deferred, a related sub-phase now unblocked,
  any checkbox you intentionally left unchecked and why).
- The next unchecked sub-phase in the plan, so they can decide whether
  to invoke `/next-step` again or redirect.

Do **not** commit or push. The user reviews and commits.

---

## Rules of engagement

- One sub-phase per invocation. Land every unchecked checkbox in the
  target `### N.M` heading; don't bleed into the next one. If the
  sub-phase is genuinely too big to land in one invocation, stop, split
  it in the plan (e.g. `### 2.2a Adapters — patient + condition`,
  `### 2.2b Adapters — meds + labs`), do the first split, and report.
- If a checkbox in the sub-phase is ambiguous or wrong (e.g. blocked by
  reality, superseded by a locked decision), stop and ask the user
  before doing the work. The plan is living — fixing it is also valid
  work. You may complete the unblocked checkboxes first and ask about
  the blocked one separately, but be explicit about which boxes you did
  and didn't flip.
- Don't add new top-level docs unless the plan explicitly asks for one.
- Don't introduce a new dependency without noting it in the plan's
  "Working agreements" rule ("No new dependencies without a one-line
  note explaining why").
- The bar from `USERS.md` always applies: when in doubt, return to Dr.
  Patel and the 90 seconds.
