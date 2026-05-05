---
description: Implement the next unchecked sub-phase in docs/week2plans/phase-<X>.md end-to-end on a fresh worktree (clarify → test → build → test → simplify → commit → MR).
---

# /next-step — Advance the Clinical Co-Pilot plan by one sub-phase

You are picking up the build of the Clinical Co-Pilot defined in
`W2_ARCHITECTURE.md` and `USERS.md`. The active sprint's living checklist
lives under `docs/week2plans/` — one file per phase (`phase-A.md`,
`phase-B.md`, …, `phase-G.md`), with `docs/week2plans/README.md` as the
index and ordering reference. Your job is to implement **one sub-phase**
of the active phase end to end, on a dedicated worktree, and leave a
merge request open for human review.

A sub-phase is a `### <Letter>.<Number>` heading like
`### A.3 Hoist loadState and planContext into the runner` with a
`**Checklist.**` block underneath containing one or more `- [ ]` items.
Complete every unchecked checkbox in that sub-phase in this invocation.
Do not bleed into the next sub-phase — when the current one's boxes are
all flipped, stop, commit, open the MR, and report.

The W1 plan at `docs/IMPLEMENTATION_PLAN.md` is preserved for traceability
of already-shipped W1 work; do **not** target it unless the user
explicitly asks. The active target is W2.

---

## 1. Orient

- Read `docs/week2plans/README.md` for phase ordering and parallelism.
- Walk the phase docs in order (`phase-A.md` → `phase-G.md`) and identify
  the **lowest-lettered phase that still has unchecked sub-phases**, then
  within it the **lowest-numbered sub-phase (`### <Letter>.<Number>`)
  that still has unchecked `- [ ]` items in its `**Checklist.**` block**.
  That is "the sub-phase." Every unchecked box in that block is in scope
  for this invocation.
- Honor the sub-phase's `**Blocked by:**` line. If any blocker is itself
  still unchecked, that blocker is the target instead. (If the blocker is
  in a different phase doc, follow the dependency.) If the blocker is
  marked `Owner: User` (e.g., a human-track prerequisite like account
  setup), stop and ask the user to confirm the blocker is satisfied
  before proceeding — do not start the agent's coding work assuming
  human-track tasks are done.
- Read the phase doc's "Phase summary" + "Phase definition of done" so
  the framing is in mind for implementation choices.
- Read **only the architecture sections referenced by the sub-phase's
  `**Refs.**` line** — not the full architecture docs. The sub-phase doc
  is intentionally written so the linked refs are sufficient.
- Read **only the files in the sub-phase's `**Files touched.**` line**
  before adding new ones. If a file already exists and the sub-phase
  expects to extend it, read it first.
- Run `git status` and `git log --oneline -10` so you understand what's
  in flight and what just shipped. Do not assume the working tree is
  clean.
- Use the Explore agent (or targeted `grep`/`Read`) to see what already
  exists in the area you're about to touch. **Do not duplicate code that
  already exists** — reuse it.

State the sub-phase you're picking up and list its unchecked checkboxes
verbatim before doing anything else, so the user can redirect if you
picked the wrong scope.

## 2. Set up the worktree

Multi-commit work runs on a sibling worktree on its own `feat/...`
branch, not on the current branch (per the user's standing preference
for multi-commit work in a worktree). Once the user confirms the
sub-phase scope from step 1:

- Pick a branch name in the form `feat/<phase>-<num>-<short-slug>`
  (e.g. `feat/A.3-hoist-loadstate`, `feat/B.7-tier1-tier2-persist`).
  Slug is lowercase, hyphenated, ≤30 chars.
- Create a sibling worktree under `../openemr-worktrees/<branch-slug>/`
  branched from the current branch's HEAD. Use a single command:
  ```sh
  git worktree add -b feat/<phase>-<num>-<slug> ../openemr-worktrees/<phase>-<num>-<slug> HEAD
  ```
  (The `<branch>` and the worktree directory share the slug for
  readability — the worktree path uses the slug without the `feat/`
  prefix to keep the directory name clean.)
- All subsequent file edits, tool runs, and commits in this invocation
  happen **inside that worktree**. State the absolute path once and
  prefix subsequent `Bash` calls with `cd <worktree-path> && ...` (or
  use absolute paths for `Read`/`Edit`/`Write`).
- If a worktree for this branch already exists from a prior failed run,
  ask the user whether to resume in it or to abandon-and-recreate. Do
  not silently delete an existing worktree.

State the worktree path and branch name in your update before
continuing.

## 3. Plan

Think through how to implement the **whole sub-phase** before writing
code:

- What's the smallest set of changes that satisfies every checkbox in
  this sub-phase?
- What order should the checkboxes go in? Some are dependency-sequenced
  (the schema-init doc can't be written before the service is wired);
  others are independent. Pick an order that keeps the tree green
  between checkboxes — and that produces a clean **commit sequence**
  for step 8 (each commit should be a logical, testable, reviewable
  step).
- What files will you touch? What new files are needed? Cross-check
  against the sub-phase's `**Files touched.**` list — if you find
  yourself wanting to touch files outside that list, pause and confirm
  the scope is right before proceeding.
- What's the test surface for each checkbox — unit, integration, eval,
  or PHPUnit isolated? You may share one test file across multiple
  checkboxes when they cover the same module.
- Does the sub-phase have implications for *later* sub-phases? Note them
  but don't pull them into this invocation.
- Are there decisions the sub-phase doc doesn't pin down (naming, exact
  shape, library choice within an already-chosen ecosystem)? Capture
  them — they may be worth flagging in the MR description for human
  reviewer confirmation.

If a decision genuinely needs the user, **ask before coding**. Bundle
*all* questions for the sub-phase into one message; don't drip-feed.
Acceptable questions: naming, API shape that affects callers,
library/version choices not already set in `package.json` or
`composer.json`, ambiguity in the sub-phase's checklist wording. Not
acceptable: things you can decide yourself by reading existing code or
the locked-decisions tables in `W2_ARCHITECTURE.md`,
`docs/WEEK2-PRESEARCH.md`, or the phase doc's `**Refs.**` block.

If everything's clear, list the checkbox order you'll work in, the
planned commit boundaries, and proceed.

## 4. Tests first (when applicable)

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

## 5. Implement

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

## 6. Verify

Once **every checkbox in the sub-phase is implemented**, run the full
gate for what you touched (from inside the worktree):

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

## 7. Simplify

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

If you make changes, re-run the gate from step 6.

## 8. Update the plan

- Flip **every** checkbox in this sub-phase in
  `docs/week2plans/phase-<Letter>.md` from `- [ ]` to `- [x]`. If a
  checkbox in scope was genuinely impossible to land in this invocation,
  leave it unchecked and explain in the report — do not flip a box you
  didn't finish.
- If the sub-phase's `**Definition of done.**` line was satisfied, the
  whole sub-phase is done; if not, leave the boxes for whatever wasn't
  finished unchecked and describe why in the MR description and the
  report.
- If you discovered something during the work that belongs in the plan
  (a new sub-task, a risk, a clarification of an adjacent item), add it
  in the right place — including, when appropriate, a brief
  parenthetical follow-up note after a completed box that captures the
  actual choices made (file paths, library decisions, behavior
  surprises). This matches the W1 `IMPLEMENTATION_PLAN.md` convention.
- Don't move existing tasks between phases — strike through and add a
  note instead.

## 9. Commit in logical steps

Now that the tree is green and the plan is updated, stage and commit
**inside the worktree**. The aim is one logical commit per checkbox or
per closely-related cluster — not one giant commit. A reviewer should be
able to read the commit list and follow the build.

Per `CLAUDE.md` and the user's standing rules:

- **Never** `--no-verify`, `--no-gpg-sign`, or `--amend` (always create
  a new commit; if a hook fails, fix the issue and create a new commit).
- **Never** stage with `git add -A` or `git add .`. Stage by name. Skip
  any `.env` or credential-shaped paths.
- Conventional Commits format: `<type>(<scope>): <description>`. Common
  types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. Scope is the
  area touched (`agent`, `copilot`, `evals`, `pipeline`, etc.). Title
  ≤72 chars; the *why* belongs in the body, not the title.
- Add the AI-assistance trailer per `CLAUDE.md`:
  ```sh
  git -C <worktree> commit \
    --trailer "Assisted-by: Claude Code" \
    -m "$(cat <<'EOF'
  feat(<scope>): <one-line description>

  <one-paragraph why — what this enables, what it removes, what's intentional>

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```
  (`Assisted-by` and `Co-Authored-By` are both standing conventions; keep
  both.)
- For multi-commit sub-phases, walk the checkbox order: stage the files
  for one logical step, commit, then move to the next. The plan-update
  commit (the `- [ ]` → `- [x]` flip in `docs/week2plans/phase-<X>.md`)
  is the **last** commit on the branch, so the prior commits are
  individually meaningful even before the plan flip.
- If a pre-commit hook fixes formatting on staged files, re-stage those
  same files (by name) and commit fresh — never `--amend`.

After committing, run `git -C <worktree> status` to confirm the tree is
clean, then `git -C <worktree> log --oneline <base>..HEAD` to print the
commit list.

## 10. Push and open the merge request

Push the branch and open the merge request on GitLab (`origin` is the
self-hosted GitLab at `labs.gauntletai.com`; use `glab`, not `gh`):

- Push: `git -C <worktree> push -u origin feat/<phase>-<num>-<slug>`.
- Open the MR with `glab` from inside the worktree:
  ```sh
  glab mr create --fill-commit-body \
    --title "<phase>.<num> <short title>" \
    --description "$(cat <<'EOF'
  ## Summary
  <2-3 bullet points: what shipped, what now works, what's intentionally not in scope>

  ## Sub-phase
  Implements `docs/week2plans/phase-<Letter>.md` §<phase>.<num>.

  ## Checkboxes flipped
  - <quoted checkbox 1 — verbatim from the plan>
  - <quoted checkbox 2>
  - …

  ## Reviewer — please double-check
  - <thing 1: a non-obvious choice that benefits from a second pair of eyes>
  - <thing 2: a place where the architecture left room for interpretation>
  - <thing 3: any test that asserts a structural rather than exact-value invariant>

  ## Decisions made along the way (please confirm)
  - <decision 1>: chose <X> over <Y> because <reason>. Confirm OK or redirect.
  - <decision 2>: ...

  ## Tests run
  - `<command 1>` — green
  - `<command 2>` — green

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```
- The MR target is `origin`'s default branch (`master` for this repo).
- If `glab` returns an auth error, surface it to the user and ask them
  to run `glab auth login` themselves — don't try to authenticate on
  their behalf.
- Capture the resulting MR URL from `glab`'s stdout for the final
  report.

**Reviewer-flag heuristic — when picking the "please double-check" and
"decisions made" bullets, prefer:**

- Naming choices that propagate beyond the worktree (public types,
  exported function names, env-var names).
- Test assertions that pin *plausibility* rather than exact value (e.g.,
  "supervisor's chosen handoff is in the allowed set" — not "supervisor
  chose X").
- Library/version choices not pinned by the architecture.
- Anything where the sub-phase doc said "decision goes in a top-of-file
  comment with a one-line rationale."
- Schema migrations, especially nullable-column additions or index
  shapes.
- Any place a real-money external call lands in CI for the first time.

Do **not** flag routine plumbing (imports, type signatures matching the
architecture, test scaffolding). The "double-check" list should be five
or fewer items; if it's longer, the sub-phase was probably too big.

## 11. Report

End with a short message to the user covering:

- The sub-phase that was completed (one line) and the count of checkboxes
  flipped (e.g. "§A.3 Hoist loadState and planContext — 5/5").
- The worktree path and branch name.
- The MR URL.
- The commit list (`git log --oneline <base>..HEAD` output, abbreviated
  if very long).
- Test command(s) that pass.
- Anything they should know before the next `/next-step`: a question
  that came up, a decision deferred, a related sub-phase now unblocked,
  any checkbox you intentionally left unchecked and why, anything in the
  MR's "please double-check" list that's especially load-bearing.
- The next unchecked sub-phase in the plan, so they can decide whether
  to invoke `/next-step` again or redirect.

Do **not** merge the MR. The user reviews and merges.

---

## Rules of engagement

- One sub-phase per invocation. Land every unchecked checkbox in the
  target `### <Letter>.<Number>` heading; don't bleed into the next one.
  If the sub-phase is genuinely too big to land in one invocation, stop,
  split it in the plan (e.g. `### B.7a Tier-1 endpoint`,
  `### B.7b Tier-2 + emitDeltas`), do the first split, and report.
- One worktree per invocation. Branch from the current HEAD; push once;
  open one MR. Don't reuse a worktree from a prior `/next-step` run
  without confirming with the user — orphaned worktrees usually mean a
  prior run failed mid-flight and the right move is to investigate, not
  to overwrite.
- If a checkbox in the sub-phase is ambiguous or wrong (e.g., blocked by
  reality, superseded by a decision in `W2_ARCHITECTURE.md` or
  `docs/WEEK2-PRESEARCH.md`), stop and ask the user before doing the
  work. The plan is living — fixing it is also valid work. You may
  complete the unblocked checkboxes first and ask about the blocked one
  separately, but be explicit about which boxes you did and didn't flip.
- Don't add new top-level docs unless the plan explicitly asks for one.
- Don't introduce a new dependency without noting it in the sub-phase's
  body and in the MR description ("New dep: `<name>@<version>` because
  `<one-line reason>`"). Pin the version.
- Don't read `.env` files (per the user's standing rule). When a
  sub-phase says "user populates env-vars on the Droplet", confirm via
  the user, not by reading the file.
- The bar from `USERS.md` always applies: when in doubt, return to Dr.
  Patel and the 90 seconds.
- Risky / hard-to-reverse actions (force-push, branch delete, dependency
  removal, anything that affects shared state) require user
  confirmation in-conversation, even within the worktree.
