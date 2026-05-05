# Phase F — Tier-3 promotion UI + side-by-side PDF.js + inline accept/reject

**Status.** Parallel with Phase G. Begin once Phase E is merged. **Sunday Noon deadline gate.**

**Phase summary.** The clinician-facing surface that turns the demo from "the agent extracts and cites" into "the clinician reviews, accepts, and the chart is updated traceably." The PDF spec's "click-to-source UI for citation snippets, with a simple document preview" requirement is satisfied at full polish. PDF.js is bundled (lazy-loaded), side-by-side layout opens on extracted-document chip click, bbox highlight overlays the cited region. Section-snippet popovers anchor to guideline chips. Inline accept/reject controls per extracted fact promote to Tier-3 chart records via the new `ObservationLabWriteService` and existing OpenEMR list/family-history paths. Demographics-delta accept/reject is a separate set of inline controls.

**Phase definition of done.**
- Click-to-source works for all three source types: chart chips link out (W1 carry-forward), extracted-document chips open side-by-side PDF with bbox overlay, guideline chips show section-snippet popover.
- Clinician can accept an extracted lab value; the value writes to OpenEMR via `ObservationLabWriteService`; the same fact transitions from `extracted_document` chip to `chart` chip on the next briefing turn.
- Demographics-delta accept/reject works through standard OpenEMR demographics-update path with audit.
- Round-trip eval: an isolated PHPUnit test asserts value/unit/refrange/abnormal-flag/`source_document_uuid` round-trip + idempotency.
- Render-test coverage for the panel template's PDF.js mount points and accept/reject anchors.
- Below 1200px width, side-by-side falls back to stacked layout (PDF below chat).

**Owner.** Engineer for code; user for review of the Tier-3 promotion UX before implementation, and for sign-off on the recording before Sunday.

**Refs.**
- `W2_ARCHITECTURE.md` §"Click-to-source UI" (Layers 1-3), §"Tier 3 — chart records (only on explicit clinician acceptance)", §"Schema migration" (Doctrine migration adds `source_document_uuid`).
- `WEEK2-PRESEARCH.md` §W2-9 (persistence path), §W2-16b (click-to-source UI).
- `W2_IMPLEMENTATION_PHASES.md` Phase F bullets.
- Existing OpenEMR services: `OpenEMR\Services\` patterns (extending `BaseService`).

---

## F.0 Human-track prerequisite: review the Tier-3 promotion UX

**Goal.** A low-fi mockup of the Tier-3 promotion UX is reviewed and signed off before any code lands. Specific decisions: where accept/reject controls sit visually relative to each fact, whether to show a confirmation toast on accept, what happens to a fact's chip after accept (transition animation, immediate refresh, next-turn refresh).

**Blocked by:** Nothing.
**Unblocks:** F.4, F.5.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase F".

**Owner.** User for review; engineer for the low-fi mockup.

**Checklist.**
- [ ] Engineer drafts a low-fi mockup (sketch or HTML stub) showing one extracted-fact card with: fact value, source chip, accept/reject button group, and what happens on click.
- [ ] User reviews. Decisions captured:
  - Accept/reject control placement (inline-right, below, separate column).
  - Confirmation toast on accept (yes / no / persistent).
  - Chip transition behavior (animated, instant, next-turn-only).
- [ ] Decisions written into the F.5 subphase comments (or a short addendum at the bottom of this doc).

**Definition of done.** F.5 implementation can begin without further UX questions.

---

## F.1 Doctrine migration: `source_document_uuid` columns

**Goal.** New nullable column `source_document_uuid VARCHAR(36)` added to `lists`, `family_history`, and `procedure_report`. Idempotent migration. No existing data is migrated; existing rows have NULL `source_document_uuid` (W1 carry-forward).

**Blocked by:** Phase E merged (so the migration goes in after the eval gate is in place to catch breakage).
**Unblocks:** F.2 (`ObservationLabWriteService` writes use the column), F.5 (intake-form Tier-3 writes use the column).

**Refs.** `W2_ARCHITECTURE.md` §"Schema migration" (Doctrine migration spec); `WEEK2-PRESEARCH.md` §W2-9.

**Files touched.**
- `db/Migrations/Version<...>.php` (new — Doctrine migration).

**Checklist.**
- [ ] Generate a new Doctrine migration via the existing OpenEMR pattern.
- [ ] Add nullable `source_document_uuid VARCHAR(36) DEFAULT NULL` column to: `lists`, `family_history`, `procedure_report`.
- [ ] Migration is idempotent (checks for existing column before adding).
- [ ] Down-migration drops the columns.
- [ ] Tests: run migration up + down on a fresh dev-easy DB; verify schema.

**Definition of done.** `docker compose exec openemr /root/devtools migrate` runs the migration cleanly. `DESCRIBE lists;` shows the new column.

---

## F.2 `ObservationLabWriteService` — Tier-3 lab promotion

**Goal.** A new PHP service writes `DiagnosticReport` per panel + `Observation` per result when a clinician accepts an extracted lab value. Idempotent on `(source_document_uuid, panel_code, collection_date)`. Fires `procedure_report.post_insert` event.

**Blocked by:** F.1.
**Unblocks:** F.5.

**Refs.** `W2_ARCHITECTURE.md` §"Tier 3 — chart records" (lab PDF row), §"`ObservationLabWriteService`"; `WEEK2-PRESEARCH.md` §W2-9; existing OpenEMR write services as a pattern (e.g., `OpenEMR\Services\Lab*`).

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ObservationLabWriteService.php` (new).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/PromoteController.php` (new — the agent-facing entry point that dispatches on fact type).
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/promote.php` (new — the endpoint).

**Checklist.**
- [ ] **`ObservationLabWriteService`:**
  - Constructor takes the connection (per CLAUDE.md "Dependency Injection" — never `new` service-layer objects).
  - `write(LabPromotionRequest $req): LabPromotionResult` where `LabPromotionRequest` is a typed DTO with `pid`, `source_document_uuid`, `panel_code`, `collection_date`, `results: ObservationResult[]`.
  - Idempotency: query for existing `(source_document_uuid, panel_code, collection_date)` — if hit, return the existing IDs.
  - Else: write `DiagnosticReport` row + per-result `Observation` rows. Each `Observation` carries `derived_from_document_uuid` extension.
  - Fires `procedure_report.post_insert` event so existing OpenEMR consumers (quality measures, exports, alerts) see the lab as a normal chart update.
- [ ] **`PromoteController`:** dispatches per fact type. POST `/promote.php?type=lab|allergy|medication_statement|past_medical_history|family_history|demographics`. Each type's payload shape is a typed DTO.
- [ ] **`promote.php` endpoint:** behind `AgentEndpointAuth`. Calls `PromoteController::dispatch(...)`. Returns the resulting chart record's UUID + a `chart_record_type` marker.
- [ ] Each promotion fires its own `AgentDisclosedEvent` with `action='tier3_promotion'` for both regulatory and engineering audit trails.
- [ ] After promotion: `extraction_artifacts.status` updated for the affected fact (need a fact-level status — see F.3).
- [ ] Tests: PHPUnit isolated tests for the service: round-trip happy path; idempotency (re-call returns same IDs); error path (invalid `panel_code`).
- [ ] PHPStan level 10 clean.

**Definition of done.** PHPUnit isolated test asserts a `DiagnosticReport` + `Observation` round-trip + idempotency on re-call.

---

## F.3 Fact-level status on `extraction_artifacts` (or sibling table)

**Goal.** Per-fact accept/reject status is tracked. The artifact-level `status` ('pending_confirmation' / 'confirmed' / 'rejected') from B.1 reflects the artifact-level disposition; per-fact status lets the UI show "5 facts accepted, 2 rejected, 3 pending" within a single artifact.

**Blocked by:** B.1.
**Unblocks:** F.5.

**Refs.** `W2_ARCHITECTURE.md` §"Tier 3 — chart records" (per-fact promotion writes own `AgentDisclosedEvent`); `WEEK2-PRESEARCH.md` §W2-9 (artifact-level + fact-level disposition).

**Files touched.**
- `agent/src/state/extractionArtifacts.ts` — new sibling table or extension.
- Migration script for the new table/column.

**Checklist.**
- [ ] Decide between (a) a new `extracted_fact_dispositions` table keyed on `(artifact_id, field_path)` with status + accepted_at + accepted_by_user, or (b) a `dispositions_json` column on the existing artifact row. (a) is cleaner for queries; (b) is a smaller migration. Default to (a) — write rationale in a top-of-file comment.
- [ ] Implement helpers: `recordDisposition(artifactId, fieldPath, status, userId)`, `getDispositions(artifactId)`. Idempotent on re-call (an already-accepted fact stays accepted; logged warning if status would change).
- [ ] Integration test: round-trip a per-fact disposition.
- [ ] When all facts on an artifact have been dispositioned, the artifact-level status auto-rolls to `confirmed` (if all accepted) or `rejected` (if all rejected) or stays `pending_confirmation` (if mixed).

**Definition of done.** Per-fact disposition round-trip works. Artifact-level status auto-rolls correctly.

---

## F.4 PDF.js bundle + side-by-side panel layout + bbox overlay

**Goal.** Click an `extracted_document` chip → side-by-side PDF.js pane opens to the right of the chat thread; the PDF loads pre-scrolled to the cited page; the cited bbox renders as a translucent overlay rectangle. PDF.js bundle is lazy-loaded (dynamic import on first click).

**Blocked by:** Phase E merged.
**Unblocks:** F.5 (the click-to-source surface needs the PDF viewer to mount the accept/reject controls).

**Refs.** `W2_ARCHITECTURE.md` §"Layer 1 — bbox overlay for extracted-document chips"; `WEEK2-PRESEARCH.md` §W2-16b (Q17 — click-to-source UI).

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/pdfViewer.js` (new) — lazy-loaded PDF.js wrapper.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js` — chip click → open viewer.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/css/panel.css` — side-by-side layout + responsive fallback.
- `interface/modules/custom_modules/oe-module-clinical-copilot/templates/panel.html.twig` — viewer mount point.

**Checklist.**
- [ ] Add PDF.js as a CDN-loaded dependency (lazy import on first chip click). Pin a specific version. Document the choice in a top-of-file comment.
- [ ] **Side-by-side layout:** above 1200px width, the panel is a 50/50 split with chat on the left and PDF viewer on the right. Below 1200px, the viewer falls back to a stacked layout (PDF below chat) — `@media (max-width: 1199px)` CSS rule.
- [ ] **Bbox overlay:** when a chip is clicked, fetch the document's bytes from OpenEMR's existing document-download endpoint (W1 carry-forward; authorized by existing OpenEMR session). Pre-scroll to the cited page. Render the bbox as a translucent `<div>` overlay positioned absolutely on top of the PDF.js page canvas.
- [ ] **Chip swap behavior:** clicking another extracted-document chip swaps the document/page/bbox in place (no reload). Clicking a non-extracted chip closes the pane.
- [ ] **First-paint latency:** the lazy import means the W1 panel's first-paint latency is unchanged. Measure with a render test (or DevTools).
- [ ] Tests: render test for the viewer mount point; JS unit test for the chip-click → viewer-mount flow (mock PDF.js); responsive test for the stacked-layout breakpoint.
- [ ] `composer update-twig-fixtures` and review.

**Definition of done.** Click an extracted-document chip on a live response → PDF opens side-by-side, scrolled to page, bbox highlighted. Clicking another chip swaps the doc/page. Below 1200px, layout stacks.

---

## F.5 Inline accept/reject controls per extracted fact

**Goal.** Each extracted fact in the "From documents" section carries small accept/reject buttons inline with the fact. Accept fires the appropriate Tier-3 promotion through `PromoteController` (per fact type). Reject marks the fact's disposition as rejected. After promotion: the fact transitions to a `chart` source-type chip on the next briefing turn.

**Blocked by:** F.0 (UX review), F.2 (`ObservationLabWriteService`), F.3 (per-fact disposition), F.4 (chip-click flow).
**Unblocks:** F.6.

**Refs.** `W2_ARCHITECTURE.md` §"Layer 3 — inline accept/reject for Tier-3 promotion"; UX decisions captured in F.0.

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/templates/panel.html.twig` — accept/reject button group per fact in "From documents".
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js` — click handlers.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/css/panel.css` — button styles.

**Checklist.**
- [ ] Render accept/reject button group inline with each fact in "From documents" (placement per F.0 review).
- [ ] **Accept flow:** click → POST `/promote.php?type=<type>` with the fact's payload → on 200, dispatch on UX decision (toast, animation, refresh). Re-render the fact in disabled state with a "Accepted" indicator until next-turn refresh.
- [ ] **Reject flow:** click → POST `/promote.php?type=<type>&action=reject` → fact disposition updated; UI hides the fact (or shows it dimmed with "Rejected" indicator).
- [ ] **Per-fact-only:** "accept all" / "reject all" deferred to post-MVP per architecture.
- [ ] Tests: render test for the button group; JS test (mocked fetch) for accept happy path + reject; integration test against a fixture extracted artifact end-to-end.

**Definition of done.** Accept an extracted lab value on a live response → see toast (or whichever UX) → `Observation` row appears in OpenEMR for the patient → next conversational turn re-cites that value with `source_type='chart'`.

---

## F.6 Demographics-delta inline controls + standard demographics-update path

**Goal.** Demographics deltas (address, phone, email) have their own inline controls. Accept writes through OpenEMR's standard demographics-update path with audit; reject dismisses the delta for this visit.

**Blocked by:** F.5.
**Unblocks:** F.7 (round-trip eval covers demographics).

**Refs.** `W2_ARCHITECTURE.md` §"Tier 3 — chart records" demographics-deltas row; `WEEK2-PRESEARCH.md` §W2-9.

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/PromoteController.php` — demographics dispatch case.
- Panel UI for the demographics-delta surfacing (likely an additional sub-section in the "From documents" group).
- An audit entry written through the standard demographics-update path's audit log + an `AgentDisclosedEvent` linking to the source document.

**Checklist.**
- [ ] Implement `PromoteController::dispatchDemographics(...)`:
  - Maps to OpenEMR's standard demographics-update path (find the existing service or controller; do not invent a new one — see `feedback_agent_uses_custom_dao_endpoints` — extend with custom-DAO style if needed).
  - Writes the change. The standard path's audit log captures it; we add an `AgentDisclosedEvent` linking the change to `source_document_uuid`.
- [ ] **Per-field accept/reject:** each delta (address, phone, email) gets its own button. Accepting one doesn't accept others.
- [ ] Tests: PHPUnit isolated test for the dispatch + audit-log write; integration test for the demographics row update.

**Definition of done.** Accept a demographics-address delta → patient's address updates in OpenEMR; standard demographics audit log captures the change; agent disclosure log records the source-document link.

---

## F.7 Round-trip eval + render-test coverage

**Goal.** F's eval cases land — round-trip PHPUnit test for lab promotion, render tests for the new template surfaces.

**Blocked by:** F.5, F.6.
**Unblocks:** Sunday Final gate.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` Phase F "Eval cases that land in F"; `WEEK2-PRESEARCH.md` Q13.

**Files touched.**
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/ObservationLabRoundTripTest.php` (new).
- `tests/Tests/Isolated/Common/Twig/fixtures/render/` — new fixtures for the panel template variants (chip + accept/reject + side-by-side).

**Checklist.**
- [ ] **Round-trip test:** isolated PHPUnit. Build a `LabPromotionRequest` with known value/unit/refrange/abnormal-flag; call `ObservationLabWriteService::write()`; read back the resulting `Observation` rows; assert byte-equal field round-trip + `source_document_uuid` populated. Re-call the service; assert idempotency (same IDs returned, no duplicate rows).
- [ ] **Render tests:** add fixtures for the panel template's PDF.js mount points and accept/reject anchors. Per CLAUDE.md "Twig template tests", run `composer update-twig-fixtures` to regenerate; review diffs before committing.
- [ ] Both run in the existing isolated/render test suites.

**Definition of done.** `composer phpunit-isolated -- --filter ObservationLabRoundTripTest` green. New render fixtures committed. Phase F's "Phase definition of done" satisfied.
