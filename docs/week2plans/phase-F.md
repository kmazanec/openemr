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

## F.5 Inline accept/reject controls per extracted fact — split into F.5a–F.5f

**Why split.** F.5 as originally written assumed only the lab path needed
to land in this subphase, since F.2 had shipped the lab write service.
In practice the user wants every extracted fact type promotable end to
end (lab, allergy, medication_statement, past_medical_history,
family_history). Each non-lab type needs its own write service against
the OpenEMR `lists` table, with its own type-specific quirks
(allergy's `verification`/`reaction`/`severity_al` columns reference
`list_options`; medication needs the `lists_medication` sibling row;
medical_problem's `diagnosis` column carries a coding-system prefix;
family_history's natural key is composite). Each is its own focused
sub-phase so the per-PR review surface stays manageable.

The original F.5 goal — "accept fires Tier-3 promotion; reject marks
disposition; fact transitions to chart chip on next turn" — is the
goal of the split as a whole. F.5a establishes the UI plumbing and
the disposition-recording surface; F.5b–F.5e add per-type write
services and flip their `PromoteController` 501s; F.5f is the
end-to-end integration test that locks the round-trip across every
type.

**Blocked by:** F.0 (UX review), F.2 (`ObservationLabWriteService`), F.3 (per-fact disposition), F.4 (chip-click flow).
**Unblocks:** F.6.

**F.0 design decisions (captured here so each split sub-phase can refer to them).**
- **Accept/reject button placement:** inline-right of the fact value, compact pair.
- **Confirmation toast:** ephemeral, ~3s, success-shaped messaging.
- **Chip transition behavior on accept:** animated swap — apply the `chart` source-type variant class with a CSS transition so the chip recolors in place; the next-turn refresh fully redraws.

---

## F.5a Inline accept/reject UI + agent dispositions endpoint (lab-only end-to-end)

**Goal.** The panel renders accept/reject buttons inline-right of every fact in the "From documents" section. Click handlers are fully wired. The accept path POSTs to `promote.php` (PHP-side Tier-3 write), then records the per-fact disposition through a new agent endpoint. The reject path POSTs the disposition directly (no chart write). For the lab fact type, the full round-trip works end-to-end: clicking accept on a recent extracted-lab value writes a `procedure_report`/`procedure_result` row through F.2's `ObservationLabWriteService`, fires the disclosure event, and flips the fact's disposition to `accepted`. For the four non-lab fact types the buttons render and the click POSTs to `promote.php`, but the controller still returns 501 (handled by the panel as a typed error toast) — the per-type write services land in F.5b–F.5e.

**Blocked by:** F.0 (decisions captured above), F.2 (lab write service), F.3 (per-fact disposition store), F.4 (chip-click flow).
**Unblocks:** F.5b, F.5c, F.5d, F.5e (each adds a new fact type to an already-working UI).

**Refs.** `W2_ARCHITECTURE.md` §"Layer 3 — inline accept/reject for Tier-3 promotion"; F.0 decisions above; F.2 / F.3 / F.4 prior subphases.

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/templates/panel.html.twig` — accept/reject button group per fact in "From documents".
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js` — click handlers, fetch wiring, toast, chip-swap animation.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/css/panel.css` — button styles, toast, chip transition.
- `agent/src/server/dispositionsRoute.ts` (new) — JWT-bearer-auth POST `/v1/agent/dispositions` route.
- `agent/src/server/index.ts` — wire the new route.
- `agent/src/graph/nodes/format.ts` — surface `artifactId` + `fieldPath` on each `extractedDocument` claim card so the panel has the data it needs to POST the disposition.

**Checklist.**
- [x] **Surface `artifactId` + `fieldPath` on extracted-document claim cards.** Already on the wire — every `Claim.sourceReferences[]` entry carries `source_id` (= artifactId) and `locator.field` (= fieldPath). The panel's `docPromotionTargetForClaim` reads them off the primary `extracted_document` ref directly; no agent-side data-shape change was needed.
- [x] **Agent `/v1/agent/dispositions` endpoint.** Implemented in `agent/src/server/routes/dispositions.ts` — POST `{artifactId, fieldPath, status}` → `recordDisposition` round-trip. 12 vitest cases cover auth, dep wiring, envelope validation, accept + reject happy paths, and the store-throw branch. Wired through `createApp` via a `Partial<Pick<...>>` dep so legacy briefing tests stay green.
- [x] **Agent `/v1/agent/accept_fact` middleman (β shape).** Implemented in `agent/src/server/routes/acceptFact.ts`. Added because the panel doesn't have the structured artifact data (analytes/values/units) and PHP can't read agent Postgres — so the panel POSTs `(artifactId, fieldPath, factType)`, the agent reads the artifact, materializes the F.2 lab body from `schemaJson.results[]`, calls `promote.php` with the panel's bearer, records the disposition. 22 vitest cases pin the lab happy path, the four 501 branches for non-lab types, every error envelope, and the disposition-fails-after-chart-write branch.
- [x] **PolicyGate `accept_fact` action.** Adds the new action to `ACTION_SCOPE_ALLOWLIST` with the union of every Tier-3 write scope (`user/DiagnosticReport.cs`, `user/AllergyIntolerance.cs`, `user/MedicationStatement.cs`, `user/Condition.cs`). Holding the union here keeps the panel from having to round-trip the type to the proxy before each click; the agent middleman is the type-aware policy point. PHPUnit tests cover the happy + cross-patient branches.
- [x] **Render accept/reject button group inline-right of each fact.** Button pair (`button.copilot-fact-actions__btn--accept`, `button.copilot-fact-actions__btn--reject`) carries `data-artifact-id`, `data-field-path`, `data-fact-type`. Renders only on `extractedDocument` section claims via `renderClaimWithChips({ withActions: true })`. The render-test layer covers the structural shape; helper-logic tests in `tests/js/copilot-panel-fact-actions.test.js` cover `factTypeForClaimCategory` + `docPromotionTargetForClaim`.
- [x] **Accept click flow.** Click → POST `/agent.php?action=accept_fact` (proxy mints `accept_fact`-scoped JWT, forwards to the agent middleman) → on 200, fire toast + animated chip swap. Non-200 surfaces a typed error toast via `messageForFactActionCode`. Routes through the shared `postFactAction` helper (the result-envelope-shape pinned by jest tests).
- [x] **Reject click flow.** Click → POST `/agent.php?action=dispositions` with `status='rejected'` → on 200, dim the claim row with strikethrough. Same shared `postFactAction` helper; same typed error toasts.
- [x] **Ephemeral toast.** ~3s, fade-in/fade-out via CSS transition (`copilot-toast--visible` / `copilot-toast--leaving`), success/error variants. Lazy-mounted container (`ensureToastContainer`) so panels that never use it pay no DOM cost. Stacks vertically.
- [x] **Animated chip swap.** After accept 200, `finalizeAccept` removes `copilot-source--document` and adds `copilot-source--chart` on every doc chip in the just-accepted claim. The CSS transition on `color`/`background-color`/`border-color` (added to both chip variants) drives the visual recolor.
- [x] **Per-fact-only:** "accept all" / "reject all" deferred to post-MVP per architecture.
- [x] Tests: 30 jest cases cover the helper logic; 12 + 22 vitest cases cover the dispositions and accept_fact routes; 25 PHPUnit cases pin PolicyGate's new action.

**Definition of done.** A clinician on a live response with an extracted-lab fact in the "From documents" section can click "Accept" → see toast → `procedure_report` + `procedure_result` rows appear in OpenEMR for the patient → next conversational turn re-cites that value with `source_type='chart'` (because the agent's snapshot now reads the new chart row). For any of the four non-lab types, clicking "Accept" produces a typed error toast ("This fact type is not yet promotable") — the buttons render, the click is wired, and F.5b–F.5e flip 501→200 incrementally without UI work.

---

## F.5b `AllergyListWriteService` — Tier-3 allergy promotion

**Goal.** New PHP write service that lands an extracted allergy fact as a `lists` row with `type='allergy'`, populating the type-specific columns (`reaction`, `verification`, `severity_al`) with values that match what the OpenEMR allergy widget displays. Idempotent on `(source_document_uuid, lower(trim(title)))`. Fires `AgentDisclosedEvent` with `categories=['allergy']`. `PromoteController` flips its 501 branch for `?type=allergy` to dispatch through this service.

**Blocked by:** F.5a (UI plumbing in place; without it the new service is unreachable from a clinician click).

**Unblocks:** F.5f (the integration test exercises every type).

**Refs.** `W2_ARCHITECTURE.md` §"Tier 3 — chart records" (intake-form → lists row); F.2 `ObservationLabWriteService` as the structural pattern; OpenEMR's `AllergyIntoleranceService` as the reference for which `lists` columns + `list_options` FKs are required for the chart UI to display the row correctly.

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyListWriteService.php` (new).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyPromotionRequest.php` (new — typed DTO).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyPromotionResult.php` (new).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyListsTableWriter.php` (new — interface, mirrors `ProcedureReportTableWriter` shape).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/Production/DbalAllergyListsTableWriter.php` (new — production DBAL impl).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/AllergyPromotionRequestParser.php` (new).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/PromoteController.php` (edit — flip the `allergy` 501 branch to dispatch the new service).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Events/AllergyListEntryCreatedEvent.php` (new — post-insert event mirroring `ProcedureReportCreatedEvent`).
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/promote.php` (edit — wire the new service into the bootstrap).
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/AllergyListWriteServiceTest.php` (new — service + controller + parser tests).

**Checklist.**
- [x] **Schema check.** F.1's `lists.source_document_uuid` covers it; allergy writes use the existing `lists` columns (`severity_al`, `reaction`, `verification`) that ship with stock OpenEMR. No new schema work.
- [x] **`AllergyPromotionRequest` DTO** with `normalizedSubstance()` helper for case-insensitive idempotency. Required: `pid`, `sourceDocumentUuid`, `substance`. Optional: `reactionOptionId`, `verificationOptionId`, `severity`, `comments`, `onsetDate`. `promotedByUserId` is controller-supplied (sourced from the verified JWT actor, never the body).
- [x] **`AllergyListWriteService::write()`.** Idempotent on `(source_document_uuid, normalizedSubstance())`. On hit, returns existing UUID with `idempotentHit=true`. On miss, inserts via `AllergyListsTableWriter::insertAllergy()`, fires `AllergyListEntryCreatedEvent`.
- [x] **`AllergyListsTableWriter` interface + `DbalAllergyListsTableWriter` impl.** Mirrors the F.2 lab writer shape. SELECT-then-INSERT idempotency with `LOWER(TRIM(title))` matched on both sides so case + whitespace variants collapse correctly. Writes the canonical `lists` row with `type='allergy'`, mints a fresh `lists.uuid` (binary), populates `severity_al` / `reaction` / `verification` / `source_document_uuid` / `user` / `pid` / `title` / `comments` / `begdate`.
- [x] **`PromoteController` dispatch flip.** Added `dispatchAllergy()` mirroring `dispatchLab()`. New `SCOPE_ALLERGY = 'user/AllergyIntolerance.cs'` public constant. Removed `TYPE_ALLERGY` from `NOT_YET_IMPLEMENTED_TYPES`. Switched the dispatcher to a `match` over the implemented types so PHPStan enforces exhaustiveness on future per-type adds. Extracted shared `fireDisclosure()` helper since lab + allergy carry the same disclosure-event shape with different categories.
- [x] **`AllergyPromotionRequestParser`** with the same boundary discipline as the lab parser — `\DomainException` on missing/invalid inputs, `promoted_by_user_id` not in the body.
- [x] **`AllergyListEntryCreatedEvent`** mirrors `ProcedureReportCreatedEvent`. Carries `listUuid`, `listRowId`, `pid`, `sourceDocumentUuid`, `substance`, `createdAt`.
- [x] **`promote.php` bootstrap edit.** Constructs both services off a shared `Connection` + `SystemClock` and passes both to `PromoteController`.
- [x] **Disclosure event fires** with `action='tier3_promotion'`, `categories=['allergy']` via the shared `fireDisclosure()` helper.
- [x] **Tests** (`AllergyListWriteServiceTest`, 13 cases): service round-trip + dispatches event; idempotent re-call (incl. case + whitespace variants); table-writer failure → `RuntimeException`; DTO rejects empty required fields; controller happy path; idempotent re-call through the dispatcher; lab-scope cannot promote allergy (cross-scope check); missing/invalid bearer/scope/body envelopes. Plus the agent-side branch flip in `acceptFact.test.ts` (3 new allergy cases) covering the materializer + the cross-doctype mismatch + unsupported-fieldPath errors.
- [x] **PHPStan level 10 clean** across the new code; no baseline entries; no `@phpstan-ignore` markers.

**Additional infra delivered alongside F.5b** (planned for F.5c–F.5e but landed early because allergy needed it):

- **`PersistedListEntry`** value object — shared by every list-shaped Tier-3 fact type (allergy + the three remaining types in F.5c–F.5e).
- **Agent-side `acceptFact` middleman flip** for `factType='allergy'`: new `materializeAllergyPromotionBody()` that reads `intake_form` artifacts' `allergies[<idx>]` slot, plus the dispatch update from "lab-only branch / 501 fallthrough" to "lab or allergy / 501 fallthrough for the remaining three types." Refactored the materialized-body type into a shared `Materialized` alias so F.5c–F.5e can mirror without redeclaring.
- **`openemrPromoteClient.PromoteResult.observationUuids`** is now structurally optional (an empty array projection for single-row chart records). Lab still returns one UUID per analyte; allergy + the three F.5c–F.5e types collapse to `[]`.

**Definition of done.** Click "Accept" on an extracted allergy fact in the panel → `lists` row with `type='allergy'`, `source_document_uuid`, and all required columns appears for the patient → fact's disposition flips to `accepted` → next conversational turn re-cites the allergy with `source_type='chart'`.

---

## F.5c `MedicationStatementWriteService` — Tier-3 patient-reported medication promotion

**Goal.** Extracted medication facts (from intake forms — patient-reported, distinct from the prescription-table flow) land as a `lists` row with `type='medication'` plus a sibling `lists_medication` row flagged as a reported (not primary) record. Idempotent on `(source_document_uuid, lower(trim(drugName)))`. `PromoteController` flips its 501 branch.

**Blocked by:** F.5a, F.5b (shared `PersistedListEntry` + `Materialized` type alias + the optional `observationUuids` projection).
**Unblocks:** F.5f.

**Refs.** `W2_ARCHITECTURE.md` §"Tier 3 — chart records" (intake-form → `lists_medication`); W1 §4.6.4 (the patient-reported-medication / `MedicationStatement` distinction); OpenEMR's `MedicationPatientIssueService` as the reference for `lists_medication` column shape; F.5b `AllergyListWriteService` as the structural pattern for everything except the two-table insert.

**Shared infra reused (already on master from F.5b).**
- `Service/PersistedListEntry` — the canonical return shape; do not declare `PersistedMedicationStatementEntry`.
- `agent/src/server/routes/acceptFact.ts` — exports a `Materialized` type alias; F.5c's `materializeMedicationStatementPromotionBody` returns it.
- `openemrPromoteClient.PromoteResult.observationUuids` is structurally optional already; medication's response collapses to `[]` (single-row chart record like allergy). No change needed.
- `PromoteController` is already a `match` over implemented types with a shared `fireDisclosure()` helper. F.5c just adds `SCOPE_MEDICATION_STATEMENT`, `dispatchMedicationStatement()`, removes `TYPE_MEDICATION_STATEMENT` from `NOT_YET_IMPLEMENTED_TYPES`, and adds the match arm.

**Files touched.**
- `src/Service/MedicationStatementWriteService.php`, `MedicationStatementPromotionRequest.php`, `MedicationStatementPromotionResult.php`, `MedicationStatementListsTableWriter.php` (interface), `Production/DbalMedicationStatementListsTableWriter.php` (impl), `Controller/MedicationStatementPromotionRequestParser.php`, `Events/MedicationStatementListEntryCreatedEvent.php`.
- `Controller/PromoteController.php` (dispatch flip + match arm).
- `public/snapshot/promote.php` (bootstrap; service constructed off the shared `Connection` + `SystemClock` like the lab + allergy writers).
- `agent/src/server/routes/acceptFact.ts` (add `materializeMedicationStatementPromotionBody`; flip the dispatch from "lab|allergy / 501 fallthrough" to "lab|allergy|medication_statement / 501 fallthrough for the remaining two types").
- `agent/tests/server/acceptFact.test.ts` (3 new vitest cases mirroring the F.5b allergy block: happy path, missing optional fields, fact_type_mismatch + unsupported_field_path).
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/MedicationStatementWriteServiceTest.php`.

**Checklist.**
- [x] **DTO** carries: `pid`, `sourceDocumentUuid`, `drugName` (the `title`), `dosageInstructions` (the `lists_medication.drug_dosage_instructions`; nullable), `usageCategory` (NOT NULL — defaults to `'patient_reported'` if the body omits it), `requestIntent` (NOT NULL — defaults to `'plan'` or `'order'` per `MedicationPatientIssueService`'s convention; pick at implementation time), `comments`, `onsetDate`, `promotedByUserId`. *(Implementation chose `community` / `Home/Community` for the usage-category default — best fit for patient-reported intake-form medications, FHIR MedicationRequest's "self-administered home meds" category — and `plan` / `Plan` for the request-intent default — chart record documenting intended use without authorizing dispense. The DTO carries both option_id + companion `*_title` columns explicitly because the schema's `*_title` columns are NOT NULL.)*
- [x] **Pass-through free text for `list_options`-shaped columns where the schema allows it.** Per the F.5b precedent (`reaction`/`verification`/`severity_al` carry agent free text without FK validation; chart UI displays as-is), `usage_category` and `request_intent` should accept free text too — but their `lists_medication` columns are NOT NULL with companion `*_title` columns, so the writer needs to populate both `usage_category` (option_id) and `usage_category_title` (display title) consistently. Confirm at implementation: do real OpenEMR rows use `option_id == title`, or are they distinct? Pick a default that satisfies the NOT NULL + the chart-UI display path. *(Confirmed distinct: `option_id` is the FHIR ValueSet code (e.g. `community`), `*_title` is the human-readable display (`Home/Community`). `MedicationPatientIssueService::populateListOptionValues()` looks up the title from `list_options.title` keyed on option_id; the writer mirrors that contract verbatim by accepting both fields and passing them through. Schema confirmed via `sql/database.sql` — `usage_category_title VARCHAR(255) NOT NULL`, `request_intent_title VARCHAR(255) NOT NULL`.)*
- [x] **Two-row insert under transaction.** `lists` row (type=medication, title, comments, begdate, source_document_uuid, …) + `lists_medication` row (list_id=newly-minted lists.id, drug_dosage_instructions, usage_category, usage_category_title, request_intent, request_intent_title, is_primary_record=0, medication_adherence_information_source=`patient`). Unlike F.5b's single-table insert, this one needs `Connection::beginTransaction()` / `commit()` / `rollBack()` like F.2 (`DbalProcedureReportTableWriter`). *(Implemented in `DbalMedicationStatementListsTableWriter::insertMedication()`; column set documented in the writer's top-of-file comment for future readers.)*
- [x] **Idempotency** on `(source_document_uuid, lower(trim(drugName)))` — the SELECT joins `lists` to `lists_medication` (LEFT JOIN so an orphaned `lists` row is still found and the writer doesn't double-insert). Same `LOWER(TRIM(...))`-on-both-sides pattern as F.5b. *(LEFT JOIN implemented even though only `lists.id`/`lists.uuid` are read back — the join shape ensures correctness if `lists_medication` insert fails between the two-row inserts on a future migration that splits them. Idempotency-key collision tested for case + whitespace variants.)*
- [x] **`PromoteController` integration:** add `SCOPE_MEDICATION_STATEMENT = 'user/MedicationStatement.cs'` (already in `PolicyGate`'s `accept_fact` scope union from F.5a), `dispatchMedicationStatement()`, the match arm, the `chart_record_type` marker (`'list_medication_statement'`).
- [x] **`promote.php` bootstrap edit.** Construct the new service alongside `labWriteService` and `allergyWriteService` off the shared connection + clock.
- [x] **Disclosure event** with `categories=['medication_statement']`. Routes through the existing `fireDisclosure()` helper.
- [x] **Agent middleman flip.** New `materializeMedicationStatementPromotionBody` reading `intake_form` artifacts' `current_medications[<idx>]` slot. Schema fields: `name` → `drug_name`; `dose` + `frequency` + `route` + `notes` compose into `dosage_instructions` (free text). Confirm the synthesizer's `medication_statement` claim category routes through the panel correctly (F.5a's `factTypeForClaimCategory` already maps it to `factType: 'medication_statement'`). *(Composed via space-join of present non-empty parts; nullable when all four sub-fields are missing. The PHP-side parser supplies `usage_category`/`request_intent` defaults so the middleman body can stay minimal.)*
- [x] **Tests:** PHPUnit (mirror F.5b's 13-case `AllergyListWriteServiceTest` shape — service round-trip, idempotency including case + whitespace variants, table-writer failure, DTO rejects empty fields, controller happy path + idempotent re-call + cross-scope rejection + missing/invalid envelopes). Plus 3 new vitest cases on the agent side. *(13 PHPUnit cases in `MedicationStatementWriteServiceTest`, 3 vitest cases — happy path, missing optional fields, fact_type_mismatch + unsupported_field_path. Lab + allergy controller tests' constructor-arg lists updated to pass the new `medicationStatementWriteService` arg with no-op stubs.)*
- [x] **PHPStan level 10 clean.** No new baseline entries; no `@phpstan-ignore`.
- [x] **Commit shape.** Bundle into one cohesive commit (per F.5b's lessons-learned: pre-commit phpstan-on-staged-files surfaces cross-file references when controller flip + service stack are split).

**Definition of done.** Click "Accept" on an extracted medication-statement fact → `lists` + `lists_medication` rows appear, flagged as a reported (not primary) record → fact's disposition flips → next turn re-cites with `source_type='chart'`.

---

## F.5d `MedicalProblemWriteService` — Tier-3 past-medical-history promotion

**Goal.** Extracted past-medical-history facts (from intake forms) land as a `lists` row with `type='medical_problem'`, populating `title` (display label) and `diagnosis` (coded value when the agent supplies one; otherwise empty / free-text). Idempotent on `(source_document_uuid, lower(trim(title)))`. `PromoteController` flips its 501 branch.

**Blocked by:** F.5a, F.5b (shared `PersistedListEntry` + `Materialized` + the F.5c-or-F.5b precedent for the shape).
**Unblocks:** F.5f.

**Refs.** OpenEMR's `ConditionService` (line 80 forces `type='medical_problem'`) as the reference for column shape; F.5b `AllergyListWriteService` as the structural pattern (medical_problem is single-table like allergy).

**Shared infra reused (already on master).**
- `Service/PersistedListEntry`.
- `agent/src/server/routes/acceptFact.ts` `Materialized` alias.
- `PromoteController` `match` dispatch + `fireDisclosure()` helper.

**Files touched.**
- `src/Service/MedicalProblemWriteService.php`, `MedicalProblemPromotionRequest.php`, `MedicalProblemPromotionResult.php`, `MedicalProblemListsTableWriter.php`, `Production/DbalMedicalProblemListsTableWriter.php`, `Controller/MedicalProblemPromotionRequestParser.php`, `Events/MedicalProblemListEntryCreatedEvent.php`.
- `Controller/PromoteController.php`, `public/snapshot/promote.php`.
- `agent/src/server/routes/acceptFact.ts` (add `materializeMedicalProblemPromotionBody`).
- `agent/tests/server/acceptFact.test.ts` (3 new vitest cases).
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/MedicalProblemWriteServiceTest.php`.

**Checklist.**
- [x] **DTO** carries: `pid`, `sourceDocumentUuid`, `title` (the human-readable condition label, e.g. "Type 2 diabetes"), `diagnosis` (optional coded value, free text or coding-system-prefixed; nullable), `verificationOptionId` (optional; pass-through per F.5b precedent), `comments`, `onsetDate`, `promotedByUserId`.
- [x] **Drop the strict coding-system prefix validation.** The intake-form schema's `past_medical_history[<idx>]` carries free-text `condition` + optional `notes`; the agent does not currently extract ICD/SNOMED codes from intake forms. Treat `diagnosis` as optional; if the agent supplies a prefixed code (e.g. `ICD10:E11.9`), pass it through verbatim. Otherwise the column stays empty and `lists.title` carries the human label. (Implementation note: live `lists.diagnosis` is `varchar(255) NULL DEFAULT NULL`, not the NOT NULL DEFAULT '' the planning doc inferred; the writer passes `''` for missing values to match the convention `ConditionService` uses where empty diagnosis is treated as "no code yet.")
- [x] **Single-row insert** into `lists` with `type='medical_problem'`. No transaction needed. Mints `lists.uuid` (binary).
- [x] **Idempotency** on `(source_document_uuid, lower(trim(title)))`. Title (not diagnosis) is the natural key because the agent reliably has a `condition` string but may not have a coded value. (Same `LOWER(TRIM(title))`-on-both-sides shape as F.5b allergy.)
- [x] **`PromoteController` integration:** add `SCOPE_MEDICAL_PROBLEM = 'user/Condition.cs'` (already in PolicyGate's `accept_fact` scope union from F.5a), `dispatchMedicalProblem()`, the match arm, the `chart_record_type` marker (`'list_medical_problem'`). `verification` is populated as the agent free-text pass-through (or `''` when omitted), matching F.5b's allergy precedent for `list_options`-shaped columns.
- [x] **Agent middleman flip.** New `materializeMedicalProblemPromotionBody` reading `intake_form` artifacts' `past_medical_history[<idx>]` slot. Maps `condition` → `title`, `onset_year` → `onset_date` (4-digit year, range 1900..currentYear+1, normalized to `YYYY-01-01`; out-of-range / non-year strings are silently dropped from the body so a malformed `onset_year` doesn't fail the whole promotion), `notes` → `comments`. Synthesizer's `medication_statement`/`diagnosis` category routing — F.5a's comment notes `diagnosis` claims map to `factType: 'past_medical_history'` because `ClaimCategory` has no `family_history` slot; F.5d inherits that decision. (See F.5e for the family-history disambiguation question.)
- [x] **Tests:** PHPUnit mirror of F.5b's 13-case shape + 3 new vitest cases (happy path with onset_year normalization; minimal body with optional fields omitted; fact_type_mismatch + unsupported_field_path bundled per F.5b shape).
- [x] **PHPStan level 10 clean.** Full-codebase run, no baseline entries, no `@phpstan-ignore`, no `@var` casts.
- [x] **Commit shape.** One cohesive commit (per F.5b's lessons-learned).

**Definition of done.** Click "Accept" on an extracted past-medical-history fact → `lists` row with `type='medical_problem'`, `title` populated, `source_document_uuid` set, `diagnosis` set if the agent supplied a coded value (else empty) → fact's disposition flips → next turn re-cites with `source_type='chart'`.

---

## F.5e `FamilyHistoryWriteService` — Tier-3 family-history promotion

**Goal.** Extracted family-history facts (from intake forms) land as a `lists` row with `type='family_history'`, populating `title` (e.g. "Mother — Type 2 diabetes"), `comments` (free-form additional context), and `begdate` if the intake form supplied an age-of-onset. Idempotent on `(source_document_uuid, lower(trim(title)))`. `PromoteController` flips its 501 branch.

**Blocked by:** F.5a, F.5b (shared `PersistedListEntry` + `Materialized` + the precedent for single-table list-row writes).
**Unblocks:** F.5f.

**Refs.** Stock OpenEMR has no dedicated family-history service; `lists` rows with `type='family_history'` are the canonical chart representation per F.1's clarification (architecture's named `family_history` table doesn't exist in stock OpenEMR). F.5b `AllergyListWriteService` as the structural pattern.

**Shared infra reused (already on master).** Same as F.5d.

**Open question carried forward from F.5a/F.5d.** The synthesizer's `ClaimCategory` enum has no `family_history` slot — both `past_medical_history` and `family_history` claims surface as `category='diagnosis'` and the panel's `factTypeForClaimCategory` maps `'diagnosis'` → `factType: 'past_medical_history'` unconditionally. Two possible resolutions when F.5e lands:

1. **Add `family_history` to `ClaimCategory` and update the synthesizer schema.** The panel maps `'family_history'` → `factType: 'family_history'`; the agent middleman dispatches correctly. Cleanest, but requires a synthesizer schema bump and a dataset version bump (per the W2 dataset-version convention).
2. **Disambiguate on the artifact side.** F.5e's middleman receives `factType: 'past_medical_history'` from the panel but the artifact's `intake_form.family_history[<idx>]` slot is the only matching `fieldPath` shape — the materializer routes on the `fieldPath` prefix (`family_history.*` → `materializeFamilyHistory`, `past_medical_history.*` → `materializeMedicalProblem`) regardless of `factType`. Less invasive, but the panel-side disambiguation is implicit.

Pick (1) at F.5e implementation time — the synthesizer-schema bump is small and the dataset-version-bump convention is already established. Captured here so the F.5e author has the decision context.

**Files touched.**
- `src/Service/FamilyHistoryWriteService.php`, `FamilyHistoryPromotionRequest.php`, `FamilyHistoryPromotionResult.php`, `FamilyHistoryListsTableWriter.php`, `Production/DbalFamilyHistoryListsTableWriter.php`, `Controller/FamilyHistoryPromotionRequestParser.php`, `Events/FamilyHistoryListEntryCreatedEvent.php`.
- `Controller/PromoteController.php`, `public/snapshot/promote.php`.
- `agent/src/server/routes/acceptFact.ts` (add `materializeFamilyHistoryPromotionBody`; flip the dispatch from "lab|allergy|medication_statement|past_medical_history / 501 fallthrough" to "all five types covered").
- `agent/tests/server/acceptFact.test.ts` (3 new vitest cases).
- `agent/src/graph/types.ts` (if option 1 above): add `'family_history'` to `ClaimCategory`. Bump synthesizer dataset versions.
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/FamilyHistoryWriteServiceTest.php`.

**Checklist.**
- [x] **Resolve the family_history-vs-past_medical_history disambiguation** (see "Open question" above). Picked option 1 — added `family_history` slot to `ClaimCategory`, synthesizer's structured-output enum, `format.ts`'s `CHART_CATEGORY_RANK`, and the panel's `factTypeForClaimCategory`. Bumped briefingGraphSuite (-v1→-v2), conversationalGraphSuite (-v2→-v3), endToEndSuite (-v2→-v3) per the W2 dataset-version convention; documentExtractionSuite stayed at -v1 (it doesn't reference `ClaimCategory`). Fixture regen produced no diff (the dataset shape itself didn't change; only the version label).
- [x] **DTO** carries: `pid`, `sourceDocumentUuid`, `relation` (e.g. "Mother", "Paternal Grandfather"), `condition` (e.g. "Type 2 diabetes", "Heart disease"), `ageOfOnset` (nullable), `comments`, `promotedByUserId`. The `title` column is computed as `"{relation} — {condition}"` (em-dash separator, exposed as `FamilyHistoryPromotionRequest::TITLE_SEPARATOR`) in the service before the idempotency lookup. `normalizedTitle()` applies lower + trim to the composite for the SELECT key.
- [x] **Single-row insert** into `lists` with `type='family_history'`. Idempotency on `(source_document_uuid, lower(trim(title)))` — composite normalization happens in the service. No transaction needed. `begdate` column receives `ageOfOnset` if supplied; null otherwise (the intake-form schema has no field for it today).
- [x] **`PromoteController` integration:** added `SCOPE_FAMILY_HISTORY = 'user/FamilyMemberHistory.cs'` (the dedicated FHIR resource for family history; `Condition.cs` would have collided with the future F.5d past-medical-history branch and let an over-broadly minted Condition token write a family-history row). Added the scope to PolicyGate's `accept_fact` allowlist + the matching PolicyGateTest assertion. Added `dispatchFamilyHistory()`, the match arm, the `chart_record_type` marker (`'list_family_history'`). Removed `TYPE_FAMILY_HISTORY` from `NOT_YET_IMPLEMENTED_TYPES`.
- [x] **Agent middleman flip.** New `materializeFamilyHistoryPromotionBody` reads `intake_form` artifacts' `family_history[<idx>]` slot. Schema fields: `relation` + `condition` are passed through *separately* (rather than pre-composed) so the PHP service owns the canonical em-dash form and idempotency normalization; `notes` → `comments`. Schema has no `age_of_onset` field today — middleman omits `onset_date`. Dispatch arm for `family_history` lands alongside the existing `lab` and `allergy` branches.
- [x] **Tests:** PHPUnit `FamilyHistoryWriteServiceTest` mirrors F.5b's 13-case shape (round-trip + dispatches event; idempotent re-call; idempotent across case+whitespace; table-writer failure → `RuntimeException`; DTO rejects empty fields; controller happy path; idempotent re-call through dispatcher; cross-scope check (lab token cannot write family history); missing/invalid envelopes). 3 new vitest cases on `acceptFact.test.ts` (family_history happy path; missing optional fields; fact_type_mismatch + unsupported_field_path). Existing `ObservationLabWriteServiceTest` and `AllergyListWriteServiceTest` updated to construct the controller with the new family-history dependency (no-op writers for unrelated branches).
- [x] **PHPStan level 10 clean.**
- [x] **Commit shape.** One cohesive commit for the implementation (PHP service + controller + agent middleman + dataset bumps + fixture regen + verifier `family_history` CategoryCheck stub); separate commit for plan flip.

**Definition of done.** Click "Accept" on an extracted family-history fact → `lists` row with `type='family_history'` and a composite `title` appears → fact's disposition flips → next turn re-cites with `source_type='chart'`.

---

## F.5f End-to-end Tier-3 promotion integration test (every fact type)

**Goal.** A single integration test exercises the full F.5a–F.5e round-trip for every fact type, using fixture extraction artifacts. Per type: build an artifact, call the agent's `accept_fact` middleman programmatically, assert the materialized body matches the per-type `promote.php` contract, assert the chart row landed with `source_document_uuid` populated, assert the `extracted_fact_dispositions` row was written, assert the disclosure event fired with the right category. Re-run the same flow and assert idempotency.

**Blocked by:** F.5a, F.5b, F.5c, F.5d, F.5e.

**Refs.** F.7's round-trip test is the lab-only scope; this is the cross-type counterpart. F.5b's `AllergyListWriteServiceTest` and the existing `ObservationLabWriteServiceTest` define the per-type cell shapes — this test wires them together end-to-end across the full type set.

**Shared infra it can lean on (already on master after F.5b).**
- Per-type `InMemory<Type>ListsTableWriter` test doubles (lab has `InMemoryProcedureReportTableWriter`; allergy has `InMemoryAllergyTableWriter`; F.5c–F.5e ship their own). F.5f composes them rather than building a single composite writer.
- `PersistedListEntry` shared shape so the test loop projects every type's result through one assertion helper.
- Agent-side `Materialized` alias so the materializer-output assertion is type-uniform across all five types.

**Files touched.**
- `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/Tier3PromotionRoundTripTest.php` (new).
- Optionally: `agent/tests/server/acceptFact.roundTrip.test.ts` — a thin vitest that asserts the middleman's full `promote.php → recordDisposition` chain for each type using a fake `OpenEmrPromoteClient` plus a fake artifact store. The PHPUnit test covers the PHP-side write services; the vitest covers the agent-side materializer fan-out. Decide at implementation time whether the cross-language coverage is worth the second test file.

**Checklist.**
- [x] One test method per fact type covering the round-trip + idempotency + disclosure (PHP side). *(`testRoundTripLab`, `testRoundTripAllergy`, `testRoundTripMedicationStatement`, `testRoundTripPastMedicalHistory`, `testRoundTripFamilyHistory` — 5 methods, 170 assertions, all passing.)*
- [x] All five test methods pass against the in-memory writers; the production DBAL writers are exercised by their own focused tests in F.5a–F.5e. *(All 5 use `Tier3RoundTrip<Type>Writer` in-memory doubles; production `Dbal*` writers are untouched.)*
- [x] Cross-type assertion helper that takes a per-type fixture and runs the same round-trip shape. *(Three helpers: `runRoundTrip()` drives the two-call sequence; `assertFirstCallShape()` pins 200/UUID/`idempotent_hit=false`/source_document_uuid populated/disclosure-fired-once; `assertIdempotentSecondCall()` pins same UUID, no duplicate row, idempotent_hit=true. Lab's asymmetric `observation_uuids` projection is handled with a single `if ($writer instanceof Tier3RoundTripProcedureReportWriter)` branch in each helper.)*
- [x] (Optional) agent-side vitest mirror. *(Skipped. `agent/tests/server/acceptFact.test.ts` is already 1,296 lines covering each fact type's materializer + promote-client interaction; a cross-language round-trip vitest mirror would not fit the <100-line bar the task description set, and the per-type vitest cases shipped in F.5a–F.5e already cover the materializer fan-out. The PHP integration test is the cross-type capstone; the vitest layer is exercised at the per-type level.)*

**Disclosure-event idempotency — gap surfaced by F.5f.** F.5f's checklist phrasing says "disclosure event fires once with the right category" across an idempotent re-call, but the production controller's `dispatch<Type>()` invokes `fireDisclosure()` unconditionally on every successful response. The write-service's entity-creation event (e.g. `AllergyListEntryCreatedEvent`) IS gated on `$result->idempotentHit` — but `tier3_promotion` `AgentDisclosedEvent` is not. F.5f pins the existing production behavior (cumulative disclosure count = 2 across two identical calls; both rows carry the same per-type category) so the test reflects what ships; production-side fix (gating `fireDisclosure()` on `!$result->idempotentHit`) was out of scope per "do not touch files outside F.5f's scope" and is captured in the test's docblock for the user/reviewer to action separately.

**Definition of done.** `composer phpunit-isolated -- --filter Tier3PromotionRoundTripTest` green; every fact type covered; idempotent re-call returns same IDs without duplicate rows; disclosure events recorded with the right per-type category.

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
- [x] Implement `PromoteController::dispatchDemographics(...)`:
  - Maps to OpenEMR's standard demographics-update path through a thin custom-DAO wrapper (`PatientServicePatientDemographicsTableWriter`) that calls `PatientService::databaseUpdate()` so the existing audit log + `BeforePatientUpdatedEvent` / `PatientUpdatedEvent` listeners fire as if a clinician edited the demographics form. The module fires its own `PatientDemographicsUpdatedEvent` alongside; the controller fires `AgentDisclosedEvent` (`action='tier3_promotion'`, `categories=['demographics']`) linking the change to `source_document_uuid`.
- [x] **Per-field accept/reject:** the body shape is single-field-per-call — DTO carries `pid`, `sourceDocumentUuid`, `field` (closed-set enum `address|phone|email`), `value` (string), `promotedByUserId`. Accepting one delta posts one body; the panel renders one button group per delta. Idempotency is "compare-then-write" on `(field, value)` — re-promoting an address that's already current is a no-op without firing the disclosure.
- [x] Tests: PHPUnit isolated test for the dispatch + audit-log write (`PatientDemographicsWriteServiceTest`, 16 cases — service round-trip + dispatches event; idempotent re-call when chart matches; missing-patient → RuntimeException; table-writer failure → RuntimeException; DTO rejects empty fields + zero pid; controller happy path; idempotent re-call through dispatcher; cross-scope rejection (lab token cannot promote demographics); missing/invalid bearer/scope/body envelopes; closed-enum `field` rejection). Plus 4 new vitest cases on the agent side (happy path with `field=address`; phone delta routing; unsupported_field_path for non-{address|phone|email} slots; schema_invalid when cited slot is missing). Integration test for the row update is the in-memory `PatientDemographicsTableWriter` round-trip plus the production `PatientServicePatientDemographicsTableWriter` wired through `PatientService::databaseUpdate()` in the bootstrap; the standard path's audit log fires automatically inside `databaseUpdate()`'s `sqlStatement` call (which is wrapped with `auditSQLEvent` in stock OpenEMR).

**Decisions documented in the {@see PatientDemographicsWriteService} top-of-file comment.**
1. Single-field-per-call DTO (one accept click promotes one delta).
2. Address shape: free-text pass-through into `street` (no parsing into structured `city`/`state`/`postal_code` columns — the chart's demographics widget displays `street` as the primary line; structured parsing is brittle and a parser hallucination would corrupt chart data). Phone goes to `phone_cell`; email to `email`. Mapping owned by `DemographicsField::patientDataColumn()`.
3. Agent middleman dispatches through `accept_fact` with a new `materializeDemographicsPromotionBody`, mirroring the F.5a–F.5e shape (consistency keeps the panel's existing accept-click handler unchanged for demographics).
4. PolicyGate scope: `user/Patient.cs` — added to the `accept_fact` allowlist; `PromoteController::SCOPE_DEMOGRAPHICS` is the matching public constant. An over-broadly minted lab token cannot smuggle through and rewrite an address.

**Refactor of `PromoteController` after F.6.** `NOT_YET_IMPLEMENTED_TYPES` was empty after F.6 flipped the last 501 branch; rather than keeping a dead `if (in_array(...))` block, the const + check were both removed. PHPStan's `match` exhaustiveness check on `dispatch()` is now the only guard against a future "added a VALID_TYPE without wiring an arm" — which is a stronger structural signal than the runtime 501 fallthrough was. `ObservationLabWriteServiceTest::testControllerReturnsNotImplementedForFutureTypes` was removed alongside (it asserted the now-gone 501 fallthrough; the static check supersedes it).

**Disclosure-event idempotency fix bundled into F.6's MR.** F.5f's round-trip integration test surfaced a real bug in the F.5b–F.5e dispatch code: `fireDisclosure()` was called unconditionally on every successful response, including idempotent re-calls. The `extended_log` + `agent_request_log` rows were being duplicated on a re-promote even though the chart row wasn't. F.6's MR fixes this across all six branches (the new demographics one + the five existing) by gating each `fireDisclosure(...)` call on `!$result->idempotentHit`. The F.5b–F.5e per-type `IdempotentReCallReturnsSameId*` tests now assert `$disclosures1 === 1, $disclosures2 === 0` — the previously-buggy duplicate-disclosure path is regression-pinned. Demographics carries the fix from day one in F.6 itself; the cross-cutting fix to the five existing branches lands in the same MR as a separate commit.

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

---

## F.8 Surface `family_history` Tier-3 writes on the Issues panel

**Goal.** F.5e's `lists` rows with `type='family_history'` land correctly in the database but are invisible to the clinician — stock OpenEMR's chart UI surfaces don't render that list type. The Issues panel (`interface/patient_file/summary/stats_full.php` and the small Issues card on the patient summary) iterates `$ISSUE_TYPES`, which is built from rows in the `issue_types` table; stock seeds seven types (`medical_problem`, `health_concern`, `medication`, `allergy`, `medical_device`, `surgery`, `dental`) and `family_history` is not one of them. Adding a single `issue_types` row for `family_history` lights up the existing generic Issues-panel rendering + the existing generic edit form (`add_edit_issue.php` is type-agnostic — no per-type branching needed for a new type) so accepted family-history facts appear alongside Allergies and Medications, matching the clinician's mental model that promoted intake-form facts live in the Issues panel.

**Why this fix not the alternatives considered.**
- **Switching F.5e's write target to `history_data`** would land rows on the History tab (where stock OpenEMR currently surfaces family history) but breaks F.5e's `(source_document_uuid, normalized_title)` idempotency contract (history_data is one-row-per-patient with free-text columns), loses the FHIR `FamilyMemberHistory` export path, and breaks the architectural symmetry with allergy/medical_problem/medication_statement (all three correctly route through `lists`).
- **Dual-write to both `lists` and `history_data`** keeps both surfaces lit but introduces conflict-resolution concerns (two sources of truth for the same fact) and roughly doubles the write surface for a feature whose canonical FHIR shape is `FamilyMemberHistory`-backed-by-`lists`.
- **Adding the `issue_types` row** (this sub-phase) preserves F.5e end-to-end as shipped, lights up the existing generic Issues-panel + edit-form pipeline, and matches the architectural pattern allergy/medical_problem/medication_statement already follow (their `issue_types` rows ship with stock OpenEMR; family_history's just doesn't, an asymmetry stock OpenEMR maintains for historical reasons).

**Why this isn't a F.5e re-do.** F.5e's `FamilyHistoryWriteService` + `DbalFamilyHistoryListsTableWriter` + parser + DTO + agent-side materializer + tests + PolicyGate scope are all correct. The only missing piece is registering the type with the chart UI's panel registry. F.8 is a one-row migration, not a service rewrite.

**Blocked by:** F.5e merged. (Met — F.5e shipped via MR #63.)
**Unblocks:** Sunday Final gate (Phase F's definition of done says clinician can see promoted facts on the chart; without F.8, that's true for four of five list types but not family_history).

**Refs.**
- `library/lists.inc.php` — `$ISSUE_TYPES` is built from `SELECT * FROM issue_types WHERE active = 1 AND category = ? ORDER BY ordering`.
- `interface/patient_file/summary/stats_full.php` (lines 215, 256) — iterates `$ISSUE_TYPES` and runs `SELECT * FROM lists WHERE pid = ? AND type = ?` for each.
- `interface/patient_file/summary/stats.php` (lines 134, 143) — same iteration for the small Issues card on the patient summary.
- `interface/patient_file/summary/add_edit_issue.php` — generic edit form; no per-type branching except for `ippf_gcac` (an unrelated specialty type).
- Stock `issue_types` seeds in `sql/database.sql` lines 3478–3484 (the seven baked-in types).
- F.1's Doctrine migration pattern (`db/Migrations/Version20260506000001.php`) — namespace `OpenEMR\Core\Migrations`, idempotency-gated INSERT.

**Files touched.**
- `db/Migrations/Version<timestamp>.php` (new — Doctrine migration that idempotently INSERTs the `issue_types` row).
- `docs/week2plans/phase-F.md` (this file — flip F.8 checkboxes when complete).

**Checklist.**
- [ ] **Generate a new Doctrine migration** following the W2 pattern set by `Version20260430000001` / `Version20260502000001` / `Version20260506000001` (F.1). Namespace `OpenEMR\Core\Migrations`. The `up()` method INSERTs one `issue_types` row; the `down()` method DELETEs it.
- [ ] **Migration is idempotent.** The INSERT is gated on `WHERE NOT EXISTS (SELECT 1 FROM issue_types WHERE category='default' AND type='family_history')` (or `INSERT IGNORE`, but the explicit gate matches F.1's pattern and is portable across MySQL + MariaDB). Re-running the migration on an already-seeded table is a no-op.
- [ ] **Row values.** Match the shape of stock seeds:
  - `category` = `'default'`
  - `type` = `'family_history'`
  - `plural` = `'Family History'`
  - `singular` = `'Family History'`
  - `abbreviation` = `'F'` (chart-tile-letter abbreviation; pick a single letter not already used — A=allergy, P=medical_problem, M=medication, HC=health_concern, I=medical_device, S=surgery, D=dental — `F` is open).
  - `style` = `0` (no special style; matches medical_problem/medication/allergy/health_concern).
  - `force_show` = `0` (panel does NOT force this section to render even when the patient has zero rows — leaving it `0` keeps the panel uncluttered for patients without family history; F.5e-promoted patients will see the section because they have rows).
  - `ordering` = `25` (between allergy=20 and medication=30 — alphabetical fit; pick what the user-track UX review prefers if different).
  - `aco_spec` = `'patients|med'` (default, same ACL as the other clinical issue types).
- [ ] **Down-migration deletes the row.** Same gate (`WHERE category='default' AND type='family_history'`) so re-running `down` on an already-deleted row is a no-op.
- [ ] **Tests:** PHPUnit isolated test under `tests/Tests/Isolated/Modules/ClinicalCopilot/Service/` (or `tests/Tests/Isolated/Migrations/` if such a directory exists) that:
  - Loads the migration class and verifies its `up()` SQL emits the expected INSERT (string-match on the SQL output).
  - Asserts the down-migration emits the corresponding DELETE.
  - **Or** a smaller unit-shape test that just instantiates the migration and confirms the SQL it would run, since running the real migration against an in-memory SQLite isn't representative.
- [ ] **End-to-end verification (manual, documented in the MR description).** Run the migration against the dev-easy DB (`docker compose exec openemr /root/devtools migrate` or `php cli migrations:migrate`); promote a family-history fact through the agent end-to-end; navigate to the patient's Issues panel; confirm a "Family History" section now appears alongside Allergies/Medications and shows the promoted row. Take a screenshot for the MR description.
- [ ] **Update the F.5e plan-doc parenthetical.** F.5e's "Definition of done" says "next conversational turn re-cites the family-history with `source_type='chart'`" — confirm in the MR description that this works post-F.8 (the agent's snapshot reads `lists WHERE type='family_history'` regardless of whether the Issues panel renders it; F.8 only affects the chart-UI surface, not the agent's read path). Add a parenthetical note to F.5e: "_(F.8 added the `issue_types` registry row so promoted family-history rows render on the Issues panel.)_".
- [ ] **Document the architectural decision** in the migration's top-of-file docblock: stock OpenEMR seeds 7 issue_types but omits family_history; this migration registers it so F.5e's writes are clinician-visible. Reference F.5e (commit `0fe687970`) and this sub-phase doc (`docs/week2plans/phase-F.md` §F.8).

**Definition of done.** Migration applied to dev-easy DB. After re-promoting a family-history fact (or with a pre-existing F.5e-promoted row), the patient's Issues panel renders a "Family History" section with the row visible. Clicking the row opens the generic `add_edit_issue.php` form pre-populated with the title (`"{relation} — {condition}"`) and any `comments`. The agent's snapshot continues to re-cite the row with `source_type='chart'` on the next conversational turn.

**Open question for human-track / UX review (optional).** The "Family History" section in the History tab (rendered from the legacy `history_data` table — see `library/report.inc.php` lines 70–75 and the patient `History` tab) remains separate from the Issues panel's new "Family History" section. The two surfaces don't sync; they represent different chart-modeling philosophies (free-text-per-relative vs structured-list-per-fact). For the demo + Sunday Final gate, the Issues panel is the canonical surface for agent-promoted facts. A future cleanup could optionally append a summary blurb to the appropriate `history_data` column (e.g. `history_mother`) when a family-history fact is promoted, so the legacy History tab also reflects the change — but that's additive, not blocking.
