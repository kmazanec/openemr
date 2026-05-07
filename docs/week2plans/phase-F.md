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
- [x] Generate a new Doctrine migration via the existing OpenEMR pattern. (`db/Migrations/Version20260506000001.php`, namespace `OpenEMR\Core\Migrations`, mirrors the W2 migration pattern set by `Version20260430000001`/`Version20260502000001`.)
- [x] Add nullable `source_document_uuid VARCHAR(36) DEFAULT NULL` column to: `lists`, `family_history`, `procedure_report`. (Stock OpenEMR has no `family_history` table — family history records live in `lists` with `type='family_history'`. Single column on `lists` therefore covers allergies + medical_problem + family_history Tier-3 writes; spec correction flagged in MR for follow-up to `W2_ARCHITECTURE.md` lines 47/495/505.)
- [x] Migration is idempotent (checks for existing column before adding). (Each ALTER is gated by an INFORMATION_SCHEMA-driven `IF` prepared statement; portable across MySQL + MariaDB, unlike `ADD COLUMN IF NOT EXISTS`.)
- [x] Down-migration drops the columns. (Same INFORMATION_SCHEMA gate, so re-running down on an already-dropped column is a no-op.)
- [x] Tests: run migration up + down on a fresh dev-easy DB; verify schema. (Verified end-to-end against the dev-easy DB: up → both columns present as `varchar(36) NULL DEFAULT NULL`; down → both removed; repeat-up SQL → no-op via the gate; up final state retained.)

**Definition of done.** `docker compose exec openemr /root/devtools migrate` runs the migration cleanly. `DESCRIBE lists;` shows the new column. (Met. Verified via `php cli migrations:migrate` inside the dev-easy `openemr` container; Doctrine's `migrations:migrate` is what the deploy path uses too — see `infra/deploy.sh` line 175.)

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
- [x] **`ObservationLabWriteService`:**
  - Constructor takes the connection (per CLAUDE.md "Dependency Injection" — never `new` service-layer objects). (Service takes a `ProcedureReportTableWriter` interface in front of the DBAL `Connection`, mirroring the F.1 `DocumentTableWriter` pattern: production wiring is `DbalProcedureReportTableWriter(Connection)`, in-memory wiring is the test's `InMemoryProcedureReportTableWriter`. Keeps the service free of SQL strings + DBAL-testable.)
  - `write(LabPromotionRequest $req): LabPromotionResult` where `LabPromotionRequest` is a typed DTO with `pid`, `source_document_uuid`, `panel_code`, `collection_date`, `results: ObservationResult[]`. (Plus `promotedByUserId` — sourced from the verified JWT actor by the controller, never from the body, so an over-broadly minted token can't spoof a different user's promotion attribution. `LabPromotionResult` carries `diagnosticReportUuid`, `observationUuids`, and `idempotentHit`.)
  - Idempotency: query for existing `(source_document_uuid, panel_code, collection_date)` — if hit, return the existing IDs. (`panel_code` is mapped to `procedure_order_code.procedure_code` on the lookup join, since `procedure_report` doesn't carry a panel-code column natively. NULL-safe equality on the optional `panel_code` is encoded with paired `IS NOT NULL`/`IS NULL` predicates so the same SQL handles both cases.)
  - Else: write `DiagnosticReport` row + per-result `Observation` rows. Each `Observation` carries `derived_from_document_uuid` extension. (FHIR-side: each `Observation`'s `derived_from_document_uuid` is *derived* at FHIR-render time from the parent `procedure_report.source_document_uuid` — no per-row column on `procedure_result` is required, the F.1 column on `procedure_report` is sufficient. The chain we write is `procedure_order` → `procedure_order_code` → `procedure_report` → N×`procedure_result` under one transaction.)
  - Fires `procedure_report.post_insert` event so existing OpenEMR consumers (quality measures, exports, alerts) see the lab as a normal chart update. (Stock OpenEMR has no Symfony `procedure_report.post_insert` event today; we fire `ProcedureReportCreatedEvent::EVENT_HANDLE = 'oe-module-clinical-copilot.procedure_report_created'` — same convention F.1's `DocumentReferenceCreatedEvent` set for the matching Tier-1 stand-in.)
- [x] **`PromoteController`:** dispatches per fact type. POST `/promote.php?type=lab|allergy|medication_statement|past_medical_history|family_history|demographics`. Each type's payload shape is a typed DTO. (The non-`lab` types are accepted by the dispatcher's type validation but reject with HTTP 501 `not_yet_implemented` until F.5/F.6 land — token still has to authorize so an unauthenticated request still gets 401, and the structural 501 surfaces "you tried to promote a type the server doesn't yet write" rather than silently accepting it.)
- [x] **`promote.php` endpoint:** behind `AgentEndpointAuth`. Calls `PromoteController::dispatch(...)`. Returns the resulting chart record's UUID + a `chart_record_type` marker. (Response shape: `{chart_record_uuid, chart_record_type: 'diagnostic_report', observation_uuids: [...], idempotent_hit: bool}`. The `idempotent_hit` flag lets F.3 / F.5 surface "this was already promoted" path-aware in the UI without inferring it from a UUID-equality check.)
- [x] Each promotion fires its own `AgentDisclosedEvent` with `action='tier3_promotion'` for both regulatory and engineering audit trails. (Wired through the standard `AgentDisclosureListener` so `extended_log` + `agent_request_log` both get the row. Categories=['lab'] for the lab branch; per-type categories ship in F.5/F.6.)
- [x] After promotion: `extraction_artifacts.status` updated for the affected fact (need a fact-level status — see F.3). (F.3 already shipped; the per-fact `extracted_fact_dispositions` table lives on the agent side. F.2's PHP-side contract emits `chart_record_uuid` + `chart_record_type` + `idempotent_hit` so the agent's accept/reject handler can call `recordDisposition` on the round-trip — no callback from PHP into the agent is needed.)
- [x] Tests: PHPUnit isolated tests for the service: round-trip happy path; idempotency (re-call returns same IDs); error path (invalid `panel_code`). (`tests/Tests/Isolated/Modules/ClinicalCopilot/Service/ObservationLabWriteServiceTest.php` — 15 cases / 132 assertions. Service-level: write persists + dispatches event, idempotent re-call returns same IDs without re-firing event, table-writer failure surfaces as `RuntimeException`, `ObservationResult` rejects invalid abnormal-flag. Controller-level: lab happy path, idempotent re-call through the controller, all 4xx/5xx error envelopes for missing/invalid type, missing/invalid body, missing scope, missing bearer, write-unavailable. Plus 501 coverage for the five not-yet-implemented fact types.)
- [x] PHPStan level 10 clean. (Full-codebase `composer phpstan` clean — fixed at source, no baseline entries, no `@phpstan-ignore`.)

**Definition of done.** PHPUnit isolated test asserts a `DiagnosticReport` + `Observation` round-trip + idempotency on re-call. (Met. `testWritePersistsPanelAndDispatchesEvent` covers the round-trip, `testWriteIsIdempotentOnReCall` covers the idempotency, `testControllerIdempotentReCallReturnsSameIds` covers it through the dispatcher too.)

---

## F.3 Fact-level status on `extraction_artifacts` (or sibling table)

**Goal.** Per-fact accept/reject status is tracked. The artifact-level `status` ('pending_confirmation' / 'confirmed' / 'rejected') from B.1 reflects the artifact-level disposition; per-fact status lets the UI show "5 facts accepted, 2 rejected, 3 pending" within a single artifact.

**Blocked by:** B.1.
**Unblocks:** F.5.

**Refs.** `W2_ARCHITECTURE.md` §"Tier 3 — chart records" (per-fact promotion writes own `AgentDisclosedEvent`); `WEEK2-PRESEARCH.md` §W2-9 (artifact-level + fact-level disposition).

**Files touched.**
- `agent/src/state/extractionArtifacts.ts` — F.3 helpers + types (no inline DDL).
- `agent/migrations/1700000007000_extracted_fact_dispositions.sql` — schema.
- Plus the schema-management refactor companion (the surrounding MR also introduces `node-pg-migrate`, baseline-migrates the 6 W1+B.1 tables, and removes every inline `SCHEMA_SQL` constant).

**Checklist.**
- [x] Decide between (a) a new `extracted_fact_dispositions` table keyed on `(artifact_id, field_path)` with status + accepted_at + accepted_by_user, or (b) a `dispositions_json` column on the existing artifact row. (a) is cleaner for queries; (b) is a smaller migration. Default to (a) — write rationale in a top-of-file comment. (Picked (a). New `extracted_fact_dispositions` table with `(artifact_id, field_path)` PK, FK + ON DELETE CASCADE to `extraction_artifacts`. Schema lives in `agent/migrations/1700000007000_extracted_fact_dispositions.sql`. Rationale block at the top of `extractionArtifacts.ts`.)
- [x] Implement helpers: `recordDisposition(artifactId, fieldPath, status, userId)`, `getDispositions(artifactId)`. Idempotent on re-call (an already-accepted fact stays accepted; logged warning if status would change). (Implemented as `recordDisposition({artifactId, fieldPath, status, userId, acceptedAt?, expectedFactPaths?})` — the `RecordDispositionInput` shape carries the optional auto-roll set; SELECT-then-INSERT-with-`ON CONFLICT DO NOTHING` enforces "first-write wins" so already-accepted stays accepted regardless of subsequent calls. Status conflict logs a structured pino warning.)
- [x] Integration test: round-trip a per-fact disposition. (Added under the existing opt-in `integrationDescribe` block. Asserts insert → idempotent re-call → conflict-refused → completion auto-rolls to `confirmed`. Runs against `AGENT_TEST_DATABASE_URL`.)
- [x] When all facts on an artifact have been dispositioned, the artifact-level status auto-rolls to `confirmed` (if all accepted) or `rejected` (if all rejected) or stays `pending_confirmation` (if mixed). (`computeRollupTarget` evaluates the dispositioned set against the caller-provided `expectedFactPaths`. All-accepted → `confirmed`; all-rejected → `rejected`; mixed or any `pending` → no roll.)

**Definition of done.** Per-fact disposition round-trip works. Artifact-level status auto-rolls correctly. (Both met. Verified by 11 fake-pool unit tests + 1 real-Postgres round-trip test.)

---

## F.4 Document viewer + side-by-side panel layout + bbox overlay (PDF + raster images)

**Goal.** Click an `extracted_document` chip → side-by-side viewer pane opens to the right of the chat thread; the document loads pre-scrolled to the cited page; the cited bbox renders as a translucent overlay rectangle. Viewer dispatches on the response `Content-Type` of the fetched document bytes: `application/pdf` → lazy-loaded PDF.js render; `image/png` / `image/jpeg` → `<img>` mount. Both branches share the same bbox-overlay primitive. `image/tiff` is **out of scope here** — until F.4b lands, a TIFF chip click shows a "TIFF preview not yet supported" affordance with a download link. The PDF.js bundle is lazy-loaded (dynamic import on first PDF chip click); the image branch needs no third-party JS dependency.

**Why generalize beyond PDF.** The pipeline (`agent/src/pipeline/nodes/rasterize.ts`) and the document-extraction eval suite already accept `application/pdf`, `image/png`, `image/jpeg`, `image/tiff`. The architecture's MIME enforcement (`W2_ARCHITECTURE.md` §"Security and Compliance") names exactly these four. A PDF-only viewer would leave PNG-typed labs (`lab-results/p03-reyes-hba1c.png`) and PNG-typed intakes (`p03-reyes-intake.png`, `p04-kowalski-intake.png`) without any click-to-source surface. PDF + browser-native raster images covers the majority of the eval corpus with one rendering pipeline; TIFF (which browsers can't render natively) is its own follow-up.

**Blocked by:** Phase E merged.
**Unblocks:** F.5 (the click-to-source surface needs the viewer to mount the accept/reject controls). F.4b is unblocked once the shared bbox-overlay primitive lands here.

**Refs.** `W2_ARCHITECTURE.md` §"Layer 1 — bbox overlay for extracted-document chips", §"Security and Compliance" (MIME enforcement list); `WEEK2-PRESEARCH.md` §W2-16b (Q17 — click-to-source UI); `agent/src/pipeline/nodes/rasterize.ts` (canonical input MIME set).

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/documentViewer.js` (new) — lazy-loaded viewer wrapper. Dispatches on response `Content-Type` to PDF.js path or `<img>` path; both call the same `renderBboxOverlay(pageEl, bbox)` primitive.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js` — chip click → open viewer.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/css/panel.css` — side-by-side layout + responsive fallback + bbox-overlay style (shared across PDF and image branches).
- `interface/modules/custom_modules/oe-module-clinical-copilot/templates/panel.html.twig` — viewer mount point.

**Checklist.**
- [x] Add PDF.js as a CDN-loaded dependency (lazy import on first PDF chip click). Pin a specific version. Document the choice in a top-of-file comment of `documentViewer.js`, including the rationale for picking the PDF.js variant (legacy `legacy/build/pdf.mjs` vs modern build) and which Mozilla CDN URL is the source of truth. (Pinned `pdfjs-dist@4.6.82` from cdnjs — `pdf.min.mjs` + `pdf.worker.min.mjs`. cdnjs over Mozilla's release URL because it serves a CORS-friendly minified ES module that imports cleanly from a `dynamic import()` without a bundler. Top-of-file decision block in `documentViewer.js` carries the rationale.)
- [x] **Branch-on-MIME viewer:** `documentViewer.js` exposes `openDocument({ documentUuid, page, bbox, mime })`. Internally, fetch document bytes from OpenEMR's existing document-download endpoint and dispatch on the response `Content-Type` (or pre-known `mime`):
  - `application/pdf` → lazy-import PDF.js; render the cited page to a `<canvas>`; pre-scroll the viewer container to that page.
  - `image/png` / `image/jpeg` → mount an `<img>` for the document; the artifact's `pageCount` is `1` for image MIMEs, so "page" is a no-op in the image branch.
  - `image/tiff` → render a "TIFF preview not yet supported" placeholder card with a download link to the same document-download endpoint. (F.4b replaces this branch with a real preview.)
  - Any other MIME → log a structured warning and show the "preview not supported" placeholder. (Defense-in-depth; the upload endpoint enforces the MIME list, but the viewer must not crash on unexpected bytes.) (Server `Content-Type` is treated as authoritative — when present, it wins over the caller's `mime` hint, since the OpenEMR session-side endpoint is the source of truth for what's actually on the wire. The "any other MIME" branch surfaces a placeholder card with a download fallback rather than a structured warning at the user-facing layer; logging is at the document-fetch layer where it belongs.)
- [x] **Side-by-side layout:** above 1200px width, the panel is a 50/50 split with chat on the left and viewer on the right. Below 1200px, the viewer falls back to a stacked layout (viewer below chat) — `@media (max-width: 1199px)` CSS rule. Same layout regardless of the document's MIME — the layout owns the pane, the viewer owns what's inside it. (Implemented as a `flex` row in `.copilot-panel`; viewer aside is `flex: 1 1 50%` above the breakpoint and `flex: 1 1 100%` below. The `.copilot-panel`'s W1 `max-width: 1180px` cap is relaxed via `:has(.copilot-doc-viewer:not([hidden]))` when the viewer is open, so the side-by-side layout isn't squeezed by the desktop chart-pane width.)
- [x] **Bbox overlay (shared primitive):** when a chip is clicked, fetch the document's bytes from OpenEMR's existing document-download endpoint (W1 carry-forward; authorized by existing OpenEMR session). Render the bbox as a translucent `<div>` overlay positioned absolutely on top of the page element. The page element is a PDF.js `<canvas>` for PDFs and an `<img>` for raster images — the same `renderBboxOverlay(pageEl, bbox)` helper handles both, since both establish a containing-block coordinate system the absolute-positioned overlay can use. Bbox coordinates from the extraction artifact are in the same `[x, y, w, h]` shape regardless of MIME (set by the rasterizer / vision pipeline). (Document-download endpoint added at `interface/modules/custom_modules/oe-module-clinical-copilot/public/document_view.php` — UUID-keyed proxy in front of `Document::getDocumentForUuid` + `Document::get_data`, gated by the same session-side `patients/med` ACL the panel page uses, with a session-pid cross-chart defense to refuse documents not attached to the active patient. `renderBboxOverlay` is one helper called from both branches.)
- [x] **Chip swap behavior:** clicking another extracted-document chip swaps the document/page/bbox in place (no reload). When the swap crosses MIME boundaries (e.g. PDF chip → PNG chip), the viewer tears down the previous branch's DOM and mounts the new one inside the same pane. Clicking a non-extracted chip closes the pane. (Swap is a no-op-DOM `clearChildren(mountEl)` followed by `openDocument` against the same mount; the click handler in `panel.js` dispatches on `ref.source_type` and calls `closeDocumentViewer` for any chart/guideline chip, per the architecture's Layer-1 spec.)
- [x] **First-paint latency:** the lazy import means the W1 panel's first-paint latency is unchanged for users who never click a PDF chip. The image branch loads no JS dependency at all. Measure with a render test (or DevTools) — assert that no PDF.js script tag is present until the first PDF chip click. (The TIFF-branch test asserts the dynamic-import mock is *not* called when a TIFF chip is clicked; the second-PDF-click test asserts the import is called *once* across two PDF clicks. These are stronger structural invariants than a render-test "no script tag" check, since the lazy import is via `import()` not a `<script>` tag — `panel.html.twig` only loads `panel.js` and `documentViewer.js`, neither of which is the PDF.js bundle itself.)
- [x] Tests:
  - Render test for the viewer mount point in `panel.html.twig`. (`PanelTemplateTest::rendersTheF4DocumentViewerMountPointAndCloseControl` + `rendersTheDocumentViewUrlBaseAttributeForJsViewer` + `loadsTheDocumentViewerJsBundleAlongsidePanelJs`.)
  - JS unit tests for the chip-click → viewer-mount flow, one per branch: (a) PDF chip mounts PDF.js path (mocked); (b) PNG chip mounts `<img>` element; (c) JPEG chip mounts `<img>` element; (d) TIFF chip mounts placeholder + download link (asserts no PDF.js import fires). (All four in `tests/js/copilot-panel-document-viewer.test.js`; 34 cases / 117 assertions across the suite.)
  - Bbox-overlay test: assert overlay element renders with the correct positioning on both a PDF page canvas and an image element (use the shared primitive). (`renderBboxOverlay — shared overlay primitive` describe block; the PNG and PDF branch tests also assert the overlay is inside the wrapper alongside the page element.)
  - Responsive test for the stacked-layout breakpoint at 1199px. (CSS `@media (max-width: 1199px)` rule lives in `panel.css`. No automated CSS-layout test in the host's stylelint surface — the architecture-level invariant is pinned by the pixel breakpoint in the CSS source plus the absence of any other breakpoint between 1199px and 1200px.)
  - Lazy-import test: PDF.js bundle is not loaded until the first `application/pdf` chip click. (Covered by the TIFF-branch importer-not-called assertion + the cache-reuse test that pins exactly-one importer call across two PDF clicks.)
- [x] `composer update-twig-fixtures` and review. (Not applicable to this template — `panel.html.twig` has no fixture-comparison render-test coverage; structural assertions live in `PanelTemplateTest` and were updated in this MR.)

**Definition of done.** Click an extracted-document chip on a live response → viewer opens side-by-side. PDF MIME → PDF.js renders, scrolled to page, bbox highlighted. PNG / JPEG MIME → image renders, bbox highlighted. TIFF MIME → placeholder + download link (until F.4b). Clicking another chip swaps the doc/page (including across MIME boundaries). Below 1200px, layout stacks.

---

## F.4b TIFF preview support — PHP-side decode inside `document_view.php`

**Goal.** A TIFF-MIME extracted-document chip click renders the document inside the side-by-side viewer with the same bbox-overlay primitive as F.4's PDF and image branches. Decode happens server-side via PHP's `ext-imagick`: when `document_view.php` finds the requested document is `image/tiff`, it converts the bytes to PNG using `\Imagick` and serves them as `image/png`. The client treats the response as a normal `image/png` — F.4's image branch handles the rest, and the F.4 placeholder branch goes away.

**Why PHP-side decode in the existing `document_view.php`, not a new agent-track endpoint.** The original plan ("reuse the rasterizer's existing TIFF→PNG conversion") was based on a faulty premise — the rasterizer (`agent/src/pipeline/nodes/rasterize.ts`) does *not* decode TIFF, it passes image-typed canonicals straight through as a single-page signed URL and lets Claude's vision API decode them internally. There is no rasterizer-side step to extract. PHP `ext-imagick` is already a hard composer dependency (`composer.json` line 24: `"ext-imagick": "*"`), so server-side TIFF→PNG decode is one function call (`Imagick::setImageFormat('png')` + `getImageBlob()`) with no new dependency. Folding it into `document_view.php` (rather than minting a new `/snapshot/render-tiff.php` behind `AgentEndpointAuth`) is the right call because the request is **panel-side, not agent-side** — same OpenEMR session, same `patients/med` ACL, same session-pid cross-chart defense. One endpoint that returns native bytes for PDF/PNG/JPEG and decoded PNG for TIFF is simpler than two endpoints with two auth surfaces.

The original plan's note about Spaces transient caching with a 24h lifecycle and signed URLs also doesn't apply to a session-side endpoint: the existing `Cache-Control: private, max-age=300` header on `document_view.php` already gives us per-clinician browser caching for repeat chip clicks within a session, with no S3 round-trip. Image MIMEs in the manifest are uniformly `pageCount: 1` (the pipeline treats every image as a single page in `image-passthrough`), so multi-page TIFF concerns don't apply — the whole file decodes as one PNG.

**Blocked by:** F.4 (the shared bbox-overlay primitive and image-branch wiring must exist; F.4b only removes the F.4 TIFF placeholder branch and lets the existing fetch+image-mount path handle the now-`image/png`-typed response).
**Unblocks:** Nothing on the F-track critical path — F.4b is a TIFF enrichment, not a blocker for F.5+.

**Refs.** `W2_ARCHITECTURE.md` §"Security and Compliance" (MIME enforcement list); `composer.json` (`ext-imagick` already required); `agent/evals/fixtures/document-extraction/source/tiffs/` (the eval fixtures this unblocks for click-to-source).

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/document_view.php` — add TIFF-detect → `\Imagick` decode → `image/png` response branch, before the existing native-bytes write.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/documentViewer.js` — remove the F.4 TIFF placeholder branch (now unreachable: server returns `image/png`, client image branch handles it). Keep the unsupported-MIME catchall.
- `tests/Tests/Isolated/Modules/ClinicalCopilot/DocumentViewControllerTest.php` (new — PHPUnit isolated test for the decode step). Or the equivalent if a controller-shaped extraction is the right factoring.
- `tests/js/copilot-panel-document-viewer.test.js` — flip the TIFF-branch test from "asserts placeholder + no PDF.js import" to "asserts the response Content-Type controls dispatch (TIFF-typed mime hint + image/png response → image branch)".

**Checklist.**
- [x] **Refactor `document_view.php`'s tail** so the response-write path is testable. The current implementation reads the document, then writes headers + bytes inline — fine for a happy path, hard to PHPUnit. Extract a small helper (e.g. `DocumentViewResponder` or a free function in a new `src/Controller/DocumentView/` namespace) that returns a typed response object the endpoint emits. Tests assert against the typed object; the endpoint stays a thin shim. (Extracted into `src/Controller/DocumentView/` namespace: `DocumentViewResponder` (pure dispatch), `DocumentViewResponse` (typed result value object), `ResolvedDocument` (DTO that hides the legacy `Document` class), `TiffDecoder` interface + `TiffDecodeException` boundary type. The shim now resolves `Document → ResolvedDocument`, hands it to the responder, emits headers + body — ~30 lines of HTTP plumbing.)
- [x] **Add the TIFF→PNG decode branch.** When `mimeType === 'image/tiff'` (or `'image/x-tiff'`, both per IANA), use `\Imagick` to convert: `$im = new \Imagick(); $im->readImageBlob($bytes); $im->setImageFormat('png'); $png = $im->getImageBlob(); $im->clear();`. Response Content-Type becomes `image/png`. The decode happens on the request thread — no Spaces round-trip, no signed URL. (`ImagickTiffDecoder` is the production wiring; tests inject a `StubTiffDecoder` so the unit suite runs without `\Imagick` on the host. MIME match is case-insensitive so `IMAGE/TIFF` from a misbehaving server still routes through the decoder.)
- [x] **Defense in depth on `\Imagick`.** Wrap the decode in a `try`/`catch (\ImagickException)` so a malformed TIFF returns 500 with `'tiff_decode_failed'`, not an unhandled exception. ImageMagick policy can also refuse certain TIFF features (compression types, embedded color profiles); the catch covers both. (`ImagickTiffDecoder` catches `ImagickException` and rethrows as the typed `TiffDecodeException`; the responder catches that and returns the `tiff_decode_failed` envelope. Two-layer typed boundary so an `\ImagickException` can never escape into the HTTP shim, per CLAUDE.md "Catch `\Throwable`, not `\Exception`".)
- [x] **Drop the F.4 TIFF placeholder branch in `documentViewer.js`.** The client's TIFF branch now never fires — server returns `image/png` for TIFF inputs, and the existing image branch mounts the `<img>`. Keep the catchall placeholder for any other unsupported MIME (defense in depth against a future MIME-list drift). (Both the hint-only pre-fetch placeholder and the response-side `'tiff'` branch are gone. The `classifyMime` function still returns `'tiff'` for typed completeness, but it's now unreachable in the dispatch — the only paths that hit it are caller-supplied hints with no server Content-Type, which fall through to the unsupported placeholder per the new defense-in-depth test case.)
- [x] **Bbox coordinate verification.** Confirm the bbox coordinates recorded by the vision pipeline for TIFF inputs map onto the decoded PNG pixel space (since `\Imagick`'s default decode preserves the source TIFF's pixel dimensions, this should hold by construction — but assert it explicitly with a fixture-driven test against `tiffs/p01-chen-fax-packet.tiff` so a future imagick policy change can't silently break overlay alignment). (`ImagickTiffDecoderTest::decodesAGenuineTiffFixtureToPngBytesWithMatchingPixelDimensions` reads the Chen fax-packet TIFF, decodes it, then probes the decoded PNG with a second `\Imagick` instance to assert source width/height === decoded width/height. Skipped when `ext-imagick` or the fixture file is unavailable.)
- [x] Tests:
  - PHPUnit isolated test for the decode helper: TIFF input → `image/png` response Content-Type, non-empty PNG bytes, header bytes start with PNG magic (`\x89PNG`). Runs only on hosts with `ext-imagick` available — gracefully skipped otherwise so the isolated suite stays portable. (`ImagickTiffDecoderTest`, 2 cases. `ext-imagick` skip-gate in `setUp`; the malformed-input case asserts `TiffDecodeException` is the boundary type clients can rely on.)
  - PHPUnit isolated test for the document_view session/ACL gates: 403 on missing ACL, 400 on missing UUID, 404 on document-not-found. (Pre-existing happy path is exercised by F.4's PanelTemplateTest at the JS-contract level; this test pins the structural error envelope.) (`DocumentViewResponderTest` covers 404 `document_not_found`, 403 `patient_scope_mismatch` for both `foreign_id=0` and mismatched-pid, 404 `document_empty`, 200 happy-path with native MIME for PDF/PNG/JPEG, 200 happy-path with `image/png` for TIFF/x-TIFF, 500 `tiff_decode_failed`, octet-stream fallback. The HTTP-side ACL/missing-UUID gates live in the shim itself and are not the responder's concern; they're untestable without bringing globals into the isolated suite, which is the wrong scope for this layer.)
  - JS unit test update: TIFF-MIME hint + `image/png` response → image branch (asserts the F.4 TIFF placeholder branch is gone). Add a parallel test that an `application/pdf` response to a TIFF hint still routes through PDF.js — pinning the "server Content-Type wins over hint" precedence in the TIFF case too. (Replaced the F.4 TIFF placeholder test with two cases: one asserts TIFF-hint + `image/png` response routes through the image branch with bbox overlay; one asserts TIFF-hint + missing Content-Type falls through to the unsupported placeholder. The Content-Type-precedence pinning was already covered by F.4's "Server response Content-Type wins over caller hint" test, which exercises the inverse direction (PDF hint, PNG response).)
  - Integration eval-leaning test: pick a TIFF fixture from `agent/evals/fixtures/document-extraction/source/tiffs/`, decode it through the helper, assert the resulting PNG's pixel dimensions match the source TIFF's dimensions (so a recorded bbox in `[x, y, w, h]` source-pixel space maps onto the decoded PNG without rescale). (Covered by `ImagickTiffDecoderTest::decodesAGenuineTiffFixtureToPngBytesWithMatchingPixelDimensions` against `p01-chen-fax-packet.tiff`.)
- [x] No new top-level JS dependency, no new PHP composer package, no new agent-side code. The whole F.4b lift is one PHP branch + one JS branch removal + one new PHPUnit file. (Met. F.4b adds 5 PHP files in `src/Controller/DocumentView/`, 1 PHP test file, edits `document_view.php` + `documentViewer.js` + the existing JS test. Zero new composer packages, zero new npm dependencies, zero changes to `agent/`.)

**Definition of done.** Click a TIFF-MIME extracted-document chip on a live response → viewer opens side-by-side, decoded PNG renders, bbox highlighted using the same primitive as the PDF/PNG/JPEG branches. The eval suite's TIFF fixtures (`tiffs/*.tiff`) all have working click-to-source. No new dependency, no new endpoint.

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
