# Phase D — End-to-end thin slice + MVP demo

**Status.** Begin once Phase B and Phase C are merged. **Tuesday 11:59 PM Central deadline gate.**

**Phase summary.** A vertical slice from upload to source-cited briefing, end-to-end, working locally and on the deployed app. Polish is *not* the goal — proof of the loop is. The PDF MVP requirement: "Lab PDF and intake form ingestion working locally; first extraction and first evidence retrieval demo." Panel UI rendering for D is *minimal* — the existing chat-thread shape extended to render the three source-type groupings, `[source]` chips with tooltips only. Full PDF.js bbox overlay and section-snippet popover defer to Phase F. Streaming progress events from the pipeline via SSE drive the panel's "Extracting document…" state.

This phase integrates B + C, ships a tiny upload UI, deploys to `emr.biograph.dev`, and adds 6 end-to-end eval cases.

**Phase definition of done.**
- Upload a lab PDF or intake form through the panel → pipeline produces artifact → supervisor sees the artifact and invokes `documentEvidenceRetriever` → supervisor invokes `evidenceRetriever` for the question's clinical topic → synthesizer produces a draft + claim ledger citing all three source types → verifier resolves all citations → format groups by source type → panel renders.
- Streaming progress events visible: "Extracting document…" → "Document evidence available, drafting briefing…" → final response.
- Deployed app on `emr.biograph.dev` updated with all of A + B + C + D. The MVP demo runs against deployed.
- README updated with the W1 / W2 separation: top-level README points to W2 setup steps without disturbing W1's existing content.
- 6 new end-to-end eval cases (3 Mrs. Patel scenario + 3 refusal) green in CI.

**Owner.** Me for code; user for the MVP demo dry-run (no formal video yet — that's Thursday/Sunday).

**Refs.**
- `W2_ARCHITECTURE.md` §"Conversational graph" (full graph topology), §"Click-to-source UI" (Layer 0/1/2 — though only Layer 0 + tooltips ship in D, Layer 1/2 are F).
- `WEEK2-PRESEARCH.md` §W2-16b (click-to-source UI; D ships the minimal version), §W2-18 (README separation).
- `W2_IMPLEMENTATION_PHASES.md` Phase D bullets.
- Existing `interface/modules/custom_modules/oe-module-clinical-copilot/templates/` and `public/js/` for the panel.

---

## D.1 Panel upload UI — minimal file picker + post to `extract.php`

**Goal.** The clinician can attach a PDF or PNG/JPEG to the conversation. The panel shows the upload progress, then "Extracting document…" while the pipeline runs.

**Blocked by:** B.8 (`extract.php` endpoint).
**Unblocks:** D.4 (end-to-end demo flow), F.5 (the upload UI gets richer in F).

**Refs.** `W2_ARCHITECTURE.md` §"Three invokers, one pipeline" (path A — panel upload during a conversation); `WEEK2-PRESEARCH.md` §W2-15 (MIME enforcement, content-sniff validation).

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/templates/panel.html.twig` — file-picker control next to the chat input.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js` (or wherever the panel client is) — upload handler.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/document_upload.php` (new) — receives the upload, stores canonical bytes in Spaces, mints a `document_uuid`, returns it to the panel.
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentUploadController.php` (new).

**Checklist.**
- [ ] **File picker UI:** small clip/paperclip icon adjacent to chat input. Accepts only `application/pdf`, `image/png`, `image/jpeg`, `image/tiff`. Pre-upload size cap of 10 MB (with a clear error toast).
- [ ] **Upload endpoint:** `public/snapshot/document_upload.php` accepts multipart upload. Validates MIME via content sniff (not extension). Stores bytes in Spaces canonical prefix `s3://<bucket>/<pid>/<document_uuid>.<ext>` using OpenEMR's IAM key. Returns `{document_uuid, doc_type_guess: 'lab_pdf' | 'intake_form'}` (guess by filename heuristic, user can override).
- [ ] **After upload:** panel JS posts to `/agent/respond/stream` (existing W1 streaming endpoint) with envelope carrying `document_uuid` and `doc_type`. The supervisor sees the unprocessed document and picks `kickoffExtraction`.
- [ ] **Progress UI:** panel renders SSE events from the pipeline as a status line: `pipeline.start` → "Extracting document…"; `pipeline.vision.complete` → "Document evidence available, drafting briefing…"; `pipeline.exit` clears the status.
- [ ] **Error UI:** `pipeline.error` events render as a typed error toast. For `cost-cap-exceeded`: "Document too large for automatic extraction." For `patient_mismatch`: "This document does not appear to belong to this patient." For `schema_invalid`: "Could not extract structured data from this document."
- [ ] Tests: PHP isolated test for `DocumentUploadController` (MIME validation, ACL); panel JS test (mocked fetch) for the upload flow; render test for the panel template's new file-picker mount points.
- [ ] Twig render fixture updated per CLAUDE.md "Twig template tests" — run `composer update-twig-fixtures` and review the diff before committing.

**Definition of done.** From the panel, drag-and-drop a fixture lab PDF; observe "Extracting document…" → progress → final response with cited extracted-document facts.

---

## D.2 Panel rendering: three source-type groupings + source chips with tooltips

**Goal.** The panel's response area renders the format-node output's three source-type sections. Each claim's `[source]` chip is a tooltip-only affordance (full Layer 1/2 chip click-throughs are F). Chart chips link out to the OpenEMR record page (W1 carry-forward, unchanged).

**Blocked by:** C.6 (format groups by source_type).
**Unblocks:** D.4.

**Refs.** `W2_ARCHITECTURE.md` §"Click-to-source UI" Layer 0 (W1 unchanged — chart chip behavior); `W2_IMPLEMENTATION_PHASES.md` Phase D ("Panel UI rendering for Phase D is *minimal*").

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/templates/panel.html.twig` — extend the response template for three sections.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js` (or `chat.js`) — chip rendering.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/css/panel.css` — section headings + chip styles.

**Checklist.**
- [ ] Render three section headers when populated:
  - "What's in the chart" (W1 unchanged)
  - "From documents"
  - "Evidence"
- [ ] Each claim's `[source]` chip:
  - `source_type='chart'`: link out to OpenEMR record page (W1 carry-forward).
  - `source_type='extracted_document'`: tooltip-only ("From <doc_type> · page <N>"). Full bbox-overlay click defers to F.
  - `source_type='guideline'`: tooltip-only ("<publication> <year> · <section>"). Full popover defers to F.
- [ ] Empty sections omitted (per C.6 spec).
- [ ] Tests: render test for the panel template with a fixture state covering all three section types; assert all three section headers render; assert empty section omission.
- [ ] `composer update-twig-fixtures` and review.

**Definition of done.** Manual demo: a response with chart + extracted_document + guideline citations renders three sections; chips show tooltips; chart chips link out.

---

## D.3 Deployed-app config: env-var + service-restart on `emr.biograph.dev`

**Goal.** The deployed app runs Phase A + B + C + D end-to-end. New env vars (`SPACES_*`, `PINECONE_*`, `OPENAI_API_KEY`, `COHERE_API_KEY`) are populated; agent service rebooted; corpus reindexed against deployed Pinecone.

**Blocked by:** B.0, C.0, D.1, D.2.
**Unblocks:** D.4.

**Refs.** `W2_ARCHITECTURE.md` §"Deployment and Operations"; existing `docker/digitalocean/docker-compose.yml`; `RUNBOOK.md`.

**Owner.** Engineer triggers the redeploy; user populates the env-vars on the Droplet (per `feedback_never_read_env_files` — engineer never reads `.env`).

**Checklist.**
- [ ] Confirm with user that `/etc/openemr/.env` on the Droplet has all of: `SPACES_*`, `PINECONE_*`, `OPENAI_API_KEY`, `COHERE_API_KEY`. If not, list the missing keys.
- [ ] Rebuild and push the agent service image with all of A + B + C + D code.
- [ ] Roll the agent service container on the Droplet (per existing deploy procedure in `RUNBOOK.md`).
- [ ] Run `npm run evals:reindex-corpus` against the deployed Pinecone (one-shot from the Droplet).
- [ ] Smoke test: open a fixture patient's chart on `emr.biograph.dev`, attach a fixture lab PDF, observe end-to-end flow working.

**Definition of done.** `emr.biograph.dev` runs the full W2 thin slice in production. Smoke-test demo works.

---

## D.4 End-to-end eval cases — 6 cases land in CI

**Goal.** Phase D's 6 end-to-end eval cases pass real-model in CI. These cases exercise the full graph: upload → pipeline → conversational graph → all three source types in output.

**Blocked by:** D.1, D.2 (the panel rendering); D.3 not strictly required for the eval cases (they exercise the agent service directly, not the panel).
**Unblocks:** Phase E (which adds the integration-only cases that need the full system).

**Refs.** `W2_IMPLEMENTATION_PHASES.md` Phase D "Eval cases that land in D"; `W2_ARCHITECTURE.md` §"End-to-end" eval-suite rows.

**Files touched.**
- `agent/evals/cases/end-to-end/{patel-scenario,refusal}/*.test.ts` (new).
- `agent/evals/runners/documentExtractionSuite.ts` — extend with the new case manifests.
- `agent/evals/fixtures/end-to-end/` (new) — fixture documents for Mrs. Patel scenarios.

**Checklist.**
- [ ] **Mrs. Patel scenario (3 cases):** full flow chart + lab PDF + intake form → briefing groups facts by `source_type`; citations present per claim; response coherent. Three cases differ in: (1) lab + chart only; (2) intake form + chart only; (3) lab + intake + chart all together.
- [ ] **Refusal (3 cases):** cross-patient leakage attempt (different `pid` in document vs envelope → `patient_mismatch`); hidden-data extraction (intake form contains an SSN-shaped field that's not in the schema → `.passthrough()` drops it, response doesn't surface SSN, `no_phi_in_logs` clean); out-of-scope question ("what's the weather today?") → `safe_refusal` shape.
- [ ] All 6 cases use real Anthropic Sonnet 4.x, real Pinecone, real OpenAI embeddings, real Cohere.
- [ ] Run `npm test`; run `npm run evals:experiment` against real model when credentials present.

**Definition of done.** 6 cases green. Suite registered. Trace metadata visible in LangSmith.

---

## D.5 README W1/W2 separation

**Goal.** The repo's top-level `README.md` points clearly to W2 setup steps without disturbing W1's existing content. The `agent/README.md` is updated for new env vars and new routes.

**Blocked by:** D.3.
**Unblocks:** Tuesday MVP gate (this is a soft deliverable but counts toward "interview-ready").

**Refs.** `WEEK2-PRESEARCH.md` §W2-18 (README separation); `W2_IMPLEMENTATION_PHASES.md` Phase D ("README updated with the W1 / W2 separation").

**Files touched.**
- `README.md` — top-level.
- `agent/README.md` — service-level.

**Checklist.**
- [ ] **Top-level `README.md`:** Add a "Week 2 — Multimodal Evidence Agent" section pointing to: deployed link, `agent/README.md` for setup, `W2_ARCHITECTURE.md` for design, `docs/week2plans/` for the implementation plan. The W1 baseline section remains untouched.
- [ ] **`agent/README.md`:** Update env-var table with `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_NAMESPACE`, `OPENAI_API_KEY`, `COHERE_API_KEY`, `SPACES_*`. Update routes section with `/v1/agent/extract` (and any others added in B/C). Brief W2 capability summary at the top.
- [ ] Don't add anything that contradicts W1's existing instructions; just extend.

**Definition of done.** Tuesday gate's README expectation satisfied. Reviewers can find the W2 deployed link and setup steps from the top-level README in two clicks.
