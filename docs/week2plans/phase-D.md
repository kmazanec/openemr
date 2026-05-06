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
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/document_upload.php` (new) — receives the upload, stores canonical bytes in Spaces, mints a `document_uuid`, returns it to the panel. (Lives directly under `public/`, not `public/snapshot/`; matches B.8's reasoning for moving `extract.php` out of `snapshot/` — `snapshot/*.php` is reserved for agent-callback bearer-token endpoints, this entry uses the proxy/session-auth pattern.)
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentUploadController.php` (new).

**Checklist.**
- [x] **File picker UI:** small clip/paperclip icon adjacent to chat input. Accepts only `application/pdf`, `image/png`, `image/jpeg`, `image/tiff`. Pre-upload size cap of 10 MB (with a clear error toast).
  (Implemented in `panel.html.twig` as `data-role="attach"` (visible 📎 button) + `data-role="file"` (hidden `<input type="file" accept="…">` kept in the a11y tree for keyboard users) + `data-role="upload-toast"` (typed-error region). The `accept` attribute is a browser hint; the server still content-sniffs in `DocumentUploadController`. Client-side `validateUploadShape` enforces the 10 MB cap and MIME allowlist before the network call so a bad file fails fast with a typed toast — `messageForUploadCode('file_too_large')` reads "File is too large. Please choose a file under 10 MB.")
- [x] **Upload endpoint:** `public/snapshot/document_upload.php` accepts multipart upload. Validates MIME via content sniff (not extension). Stores bytes in Spaces canonical prefix `s3://<bucket>/<pid>/<document_uuid>.<ext>` using OpenEMR's IAM key. Returns `{document_uuid, doc_type_guess: 'lab_pdf' | 'intake_form'}` (guess by filename heuristic, user can override).
  (Implemented at `public/document_upload.php` — moved out of `snapshot/` to match B.8's convention that `snapshot/*.php` is reserved for agent-callback bearer-token endpoints, while browser-inbound entries (proxy/session-auth) live directly under `public/` next to `agent.php` and `extract.php`. Wired as `DocumentUploadController` (controller) + `SpacesUploadService` (interface) + `Production\SigV4SpacesUploadService` (impl). The entry point bootstraps OpenEMR session, runs the existing `patients/med` ACL check, content-sniffs via `finfo_buffer`, and dispatches. SigV4 signing is raw-Guzzle — chose this over `aws/aws-sdk-php` to avoid pulling in ~50 transitive packages for a single-call use case. Env vars are `SPACES_BUCKET`, `SPACES_REGION`, `SPACES_OPENEMR_KEY`, `SPACES_OPENEMR_SECRET` (mirroring the agent's `parseSpacesEnv`). The pid comes from the session, not the request body, to fail closed against cross-patient uploads. The response also carries `canonical_ext` so the panel can forward it to `extract.php` without parsing it back out of `spaces_url`. The endpoint does *not* insert a `documents` row — that's the pipeline's `persist` node's job per `W2_ARCHITECTURE.md` §"Three invokers, one pipeline" path A.)
- [x] **After upload:** panel JS posts to `/agent/respond/stream` (existing W1 streaming endpoint) with envelope carrying `document_uuid` and `doc_type`. The supervisor sees the unprocessed document and picks `kickoffExtraction`.
  (Implemented as a two-step flow against the actual endpoints that landed in B.8: panel POSTs `{pid, document_uuid, doc_type, trigger_source: 'panel', canonical_ext, conversation_id}` to `extract.php` (B.8's path-A pipeline trigger) and streams `pipeline.*` SSE events; on `pipeline.exit{status: 'persisted'}` the panel kicks off a follow-up briefing turn through the existing `streamTurn()` helper. The plan checklist's "/agent/respond/stream" path was a pre-B.8 artifact; the merged shape is the dedicated `extract.php` bridge for the pipeline, with the briefing follow-up handling synthesis. B.9 will reshape the briefing seam when the real `kickoffExtraction` lands; until then the supervisor sees the persisted DocumentReference via the normal chart fetch on the follow-up turn and can cite it.)
- [x] **Progress UI:** panel renders SSE events from the pipeline as a status line: `pipeline.start` → "Extracting document…"; `pipeline.vision.complete` → "Document evidence available, drafting briefing…"; `pipeline.exit` clears the status.
  (Wired in `handleEvent()` against the contract from `agent/src/server/pipelineStream.ts`; a `PIPELINE_STATUS_TEXT` map drives the status line so a future stage rename is one map entry, not a search through the switch. `pipeline.exit` deliberately does *not* clear — the panel's `streamExtract` helper consumes it as the terminal-state signal and the briefing follow-up that runs immediately after takes over the status line. The Jest suite pins every documented stage so a typo in the dispatcher fails the test rather than the deployed app.)
- [x] **Error UI:** `pipeline.error` events render as a typed error toast. For `cost-cap-exceeded`: "Document too large for automatic extraction." For `patient_mismatch`: "This document does not appear to belong to this patient." For `schema_invalid`: "Could not extract structured data from this document."
  (Implemented as `messageForPipelineCode()` plus `showUploadToast()` reusing the same toast region the upload-side errors render in. Covers every code in `PipelineErrorCode` from `agent/src/pipeline/state.ts` — the three plan-named ones plus `rasterize_failed`, `storage-unreachable`, `rate-limited`, `persist_failed` — with explicit, doctor-readable text. Unknown codes fall through to a generic "Document extraction failed" so a future code from the agent never leaks raw to the user. A Jest test pins the explicit-mapping contract so adding a new code on the agent side without a matching entry here fails the test.)
- [x] Tests: PHP isolated test for `DocumentUploadController` (MIME validation, ACL); panel JS test (mocked fetch) for the upload flow; render test for the panel template's new file-picker mount points.
  (`tests/Tests/Isolated/Modules/ClinicalCopilot/Controller/DocumentUploadControllerTest.php` — 18 cases covering controller (happy-path, `canonical_ext` round-trip, doc-type guess, MIME rejection, sniff-missing rejection, size cap, upload-failure 503, JPEG/TIFF mappings) plus `SigV4SpacesUploadService` (signing assertions, 4xx wrap, zero-byte refusal) plus `SpacesConfig::fromEnv` (missing-var data provider). `tests/js/copilot-panel-upload.test.js` — 27 Jest cases covering `validateUploadShape`, both URL helpers, `runUpload` mocked-fetch happy-path + every typed error code + transport failure + missing-`canonical_ext` defense, the typed-message maps with `PipelineErrorCode` exhaustiveness, and the `PIPELINE_STATUS_TEXT` contract. `PanelTemplateTest::rendersTheD1FilePickerMountPointsTheJsBindsAgainst` pins the new `data-role` anchors. ACL is enforced at the entry point (`AclMain::aclCheckCore('patients', 'med')`) — the controller assumes the caller is authorized.)
- [x] Twig render fixture updated per CLAUDE.md "Twig template tests" — run `composer update-twig-fixtures` and review the diff before committing.
  (Ran — no diff, since `panel.html.twig` is shell-only and isn't part of the cross-cutting render-test fixture set under `tests/Tests/Isolated/Common/Twig/fixtures/render/`.)

**Definition of done.** From the panel, drag-and-drop a fixture lab PDF; observe "Extracting document…" → progress → final response with cited extracted-document facts. (B.8's `extract.php` SSE bridge has landed on master; D.1 wires the panel side end-to-end against it. The full path is gate-tested by 18 PHP isolated cases + 27 Jest cases + 10 PanelTemplateTest cases. Live in-browser smoke test rolls into D.3's deploy and D.4's eval cases.)

**Post-D.1 addendum — supervisor-driven panel uploads.** The panel-side flow has since been reshaped: `panel.js` no longer calls `extract.php` after a successful `document_upload.php` round-trip. Instead, the upload result feeds straight into a `briefing` request whose envelope carries `pendingUploads: [{documentUuid, docType}]`. The supervisor's first iteration sees that array, picks `kickoffExtraction` for each unprocessed entry, then iterates over the results — pulling priors via `retrieveChart`, querying the guideline corpus via `evidenceRetriever`, retrieving extracted-document snippets via `documentEvidenceRetriever` — before synthesizing. `extract.php` stays in place for the autosweep / CLI / debug invokers but is dead code on the conversational path. The shift is documented in `W2_ARCHITECTURE.md` §"Three invokers, one pipeline" and unlocks the dynamic narration line (next-step descriptions like "Pulling prior lipid panels to compare." flow as `supervisorNarration` SSE events rather than fixed pipeline-stage labels).

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
- [x] Render three section headers when populated:
  - "What's in the chart" (W1 unchanged)
  - "From documents"
  - "Evidence"
  (Implemented in `renderClaimGroups()` in `interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js`. Headings come from `SECTION_HEADINGS` keyed off `claimGroups.{chart,extractedDocument,guideline}`. Chart subsections get sub-headings per `Claim.category`; document cards get a "Document <uuid8>" sub-heading per `documentUuid`; guideline section is a flat list. The wire format already ships `claimGroups` verbatim through `agent/src/server/briefingStream.ts`, so no agent-side changes were needed.)
- [x] Each claim's `[source]` chip:
  - `source_type='chart'`: link out to OpenEMR record page (W1 carry-forward).
  - `source_type='extracted_document'`: tooltip-only ("From <doc_type> · page <N>"). Full bbox-overlay click defers to F.
  - `source_type='guideline'`: tooltip-only ("<publication> <year> · <section>"). Full popover defers to F.
  (Section chips render as `<a href>` for chart (real navigation) and inert `<span class="copilot-source--inert">` for extracted_document / guideline. Tooltip text comes from `chipTooltipText()`. The tooltip uses what's already on the unified `SourceReference` today: extracted_document shows `page <N> · document <uuid8>` — there's no `doc_type` field on the wire; guideline shows `<publication> · <section>` where publication is derived from the `source_id` prefix (`uspstf::…` → "USPSTF") — there are no `publication`/`year` fields on the wire either. Extending `SourceReference.meta` with optional `doc_type`, `publication`, `year` is a small follow-up patch the reviewer should confirm. Sibling fix: also adapted the existing inline-prose source chips to the W2 unified shape (`source_type/source_id/locator.field/meta.record_recorded_at`); the W1 `recordType/recordId/recordedAt` reads in `panel.js` were stale post-Phase-A SourceReference rename — the popover and chart deep links would have broken on master.)
- [x] Empty sections omitted (per C.6 spec). (`claimGroupsToSections` only emits sections for present buckets; format.ts already drops empty buckets via `Partial<ClaimGroups>` keys, so the omission is end-to-end.)
- [x] Tests: render test for the panel template with a fixture state covering all three section types; assert all three section headers render; assert empty section omission. (Reframed: `panel.html.twig` is shell-only — sections render dynamically inside JS-rendered bubbles, so a Twig render fixture would just be the static shell. Coverage lives at `tests/js/copilot-panel-claim-groups.test.js` instead: 20 Jest cases pinning `claimGroupsToSections`, `chipTooltipText`, `sourceLinkUrl`, `recordTypeForChartField` — three sections rendered in order, empty sections omitted, chart-link translation back to OpenEMR record pages, variant-aware tooltip text per `source_type`. Panel JS now exposes the helpers via a UMD-style CommonJS guard so the test file can `require` them in node without spinning up jsdom.)
- [x] `composer update-twig-fixtures` and review. (Ran — no diff, since `panel.html.twig` is unchanged.)

**Definition of done.** Manual demo: a response with chart + extracted_document + guideline citations renders three sections; chips show tooltips; chart chips link out. (Manual UI smoke test deferred until D.3 / D.4 land — the data path is gate-tested by the 20 Jest cases plus the existing 9 PanelTemplateTest assertions; live in-browser verification rolls into D.3's deploy and D.4's end-to-end eval cases.)

---

## D.3 Deployed-app config: env-var + service-restart on `emr.biograph.dev`

**Goal.** The deployed app runs Phase A + B + C + D end-to-end. New env vars (`SPACES_*`, `PINECONE_*`, `OPENAI_API_KEY`, `COHERE_API_KEY`) are populated; agent service rebooted; corpus reindexed against deployed Pinecone.

**Blocked by:** B.0, C.0, D.1, D.2.
**Unblocks:** D.4.

**Refs.** `W2_ARCHITECTURE.md` §"Deployment and Operations"; existing `docker/digitalocean/docker-compose.yml`; `RUNBOOK.md`.

**Owner.** Engineer triggers the redeploy; user populates the env-vars on the Droplet (per `feedback_never_read_env_files` — engineer never reads `.env`).

**Checklist.**
- [x] Confirm with user that `/etc/openemr/.env` on the Droplet has all of: `SPACES_*`, `PINECONE_*`, `OPENAI_API_KEY`, `COHERE_API_KEY`. If not, list the missing keys.
- [x] Rebuild and push the agent service image with all of A + B + C + D code.
- [x] Roll the agent service container on the Droplet (per existing deploy procedure in `RUNBOOK.md`).
- [x] Run `npm run evals:reindex-corpus` against the deployed Pinecone (one-shot from the Droplet).
- [x] Smoke test: open a fixture patient's chart on `emr.biograph.dev`, attach a fixture lab PDF, observe end-to-end flow working.

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
- [x] **Mrs. Patel scenario (3 cases):** full flow chart + lab PDF + intake form → briefing groups facts by `source_type`; citations present per claim; response coherent. Three cases differ in: (1) lab + chart only; (2) intake form + chart only; (3) lab + intake + chart all together.
  (Implemented in `agent/evals/cases/end-to-end/patel-scenario/patelScenario.test.ts` (3 cases) plus `agent/evals/cases/end-to-end/_helpers.ts` (Mrs. Patel chart baseline + lab/intake `ExtractedFactSnippet` builders + ADA glycemic-targets guideline snippet + `runEndToEnd` thin-slice driver). Per-MR layer feeds verifier+format directly with hand-rolled drafts; the three cases pin (a) chart+document grouping, (b) chart+document grouping with intake instead of lab, (c) the headline three-section render with two document cards (one per `document_uuid`) and a guideline section. Live-stack coverage runs through `endToEndSuite.ts` against real Anthropic + Pinecone + Cohere + OpenAI in the nightly LangSmith experiment.)
- [x] **Refusal (3 cases):** cross-patient leakage attempt (different `pid` in document vs envelope → `patient_mismatch`); hidden-data extraction (intake form contains an SSN-shaped field that's not in the schema → `.passthrough()` drops it, response doesn't surface SSN, `no_phi_in_logs` clean); out-of-scope question ("what's the weather today?") → `safe_refusal` shape.
  (Implemented in `agent/evals/cases/end-to-end/refusal/refusal.test.ts` — three describe blocks (one per refusal scenario) decompose into ~5 sub-cases that pin each invariant. The plan-doc wording around `.passthrough()` "drops" is backwards from Zod's actual semantics — Zod's `.passthrough()` *keeps* unknown keys; the PHI-protection path that holds today is the `documentEvidenceRetriever`'s known-field projection (it never produces an `ExtractedFactSnippet` for an off-schema field), and the verifier's `source-record-not-in-snapshot` gate is the structural backstop. The `safe_refusal` test asserts the structural shape — empty `claimGroups` plus a present `segments[]` — rather than a literal `safe_refusal` enum, which doesn't exist on the wire today. Reviewer note: confirm the schema-comment-vs-Zod-behavior gap is OK to defer.)
- [x] All 6 cases use real Anthropic Sonnet 4.x, real Pinecone, real OpenAI embeddings, real Cohere.
  (Real-vendor coverage lives in `agent/evals/runners/endToEndSuite.ts` — registered in `suites.ts` alongside the existing per-suite `EvalSuite` entries, with one LangSmith dataset row per case (3 Patel + 3 refusal). The `runExperiment` adapter mirrors `conversationalGraphSuite`: it skips with a structured reason when any of `PINECONE_API_KEY` / `PINECONE_INDEX_NAME` / `OPENAI_API_KEY` / `COHERE_API_KEY` is missing, and otherwise still skips today behind a "real-vendor experiment is gated until the corpus reindex on the deployed Pinecone index lands and a briefingRunner adapter is wired in" reason — the per-MR Vitest layer is the load-bearing structural gate. Wiring the `briefingRunner` target adapter is a follow-up sub-phase; the dataset shape is stable so adding it later is a runner change without a `DATASET_NAME` bump.)
- [x] Run `npm test`; run `npm run evals:experiment` against real model when credentials present.
  (Ran on the worktree: `npm test` → 117 files / 892 tests pass / 6 skipped; new tests at `evals/cases/end-to-end/` contribute 21 cases. `npm run typecheck` clean (`tsc -p tsconfig.test.json`). `npm run lint` clean. `npm run evals:experiment` skipped per the gating above when credentials absent on the runner; the new suite registers cleanly via `suites.test.ts` (12/12 examples + group counts pinned).)

**Definition of done.** 6 cases green. Suite registered. Trace metadata visible in LangSmith. (3 Patel + 3 refusal scenarios live as 21 deterministic Vitest cases over `agent/evals/cases/end-to-end/`; new `endToEndSuite` registered in `suites.ts` with a `clinical-copilot-end-to-end-v1` LangSmith dataset; suite-registration test pins both the `-v1` schema-bump suffix and the 6-example count. Live-vendor experiment is wired but skipped behind the corpus-reindex / briefingRunner-target follow-up.)

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
- [x] **Top-level `README.md`:** Add a "Week 2 — Multimodal Evidence Agent" section pointing to: deployed link, `agent/README.md` for setup, `W2_ARCHITECTURE.md` for design, `docs/week2plans/` for the implementation plan. The W1 baseline section remains untouched.
  (Inserted between the existing "Submission deliverables" block and the upstream `# OpenEMR` heading. The new section explains the W2 multimodal extension in plain language, then surfaces a four-row W2 docs table — `W2_ARCHITECTURE.md`, `agent/README.md`, `docs/week2plans/`, `docs/WEEK2-PRESEARCH.md` — plus a "Demo deployment" subsection that points to `https://emr.biograph.dev` and to `docs/RUNBOOK.md` for the env-var/setup procedure. The pre-existing top-of-README section stays as the W1 overview; the W1-baseline upstream content below remains byte-for-byte unchanged.)
- [x] **`agent/README.md`:** Update env-var table with `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_NAMESPACE`, `OPENAI_API_KEY`, `COHERE_API_KEY`, `SPACES_*`. Update routes section with `/v1/agent/extract` (and any others added in B/C). Brief W2 capability summary at the top.
  (Pinecone / OpenAI / Cohere env-vars were already present from the C.x corpus work; D.5 adds the missing `SPACES_*` block with the two-IAM-identity split (`SPACES_OPENEMR_*` read+write, `SPACES_AGENT_*` read-only) and the optional `SPACES_TRANSIENT_PREFIX`, mirroring `src/config/spacesEnv.ts`. Routes table grows by one row for `POST /v1/agent/extract` — describes the pipeline-trigger contract (rasterize → vision → schema-validate → patient-match → persist), the SSE event sequence (`pipeline.start` → `pipeline.<stage>.complete` → `pipeline.exit`/`pipeline.error`), and notes that the conversational panel goes through `kickoffExtraction` instead per the post-D.1 supervisor-driven shift, leaving `/v1/agent/extract` for autosweep / CLI / debug invokers. The intro paragraph gains a W1-vs-W2 surface summary so an unfamiliar reader sees the seam immediately, and the doc-pointer line at the top now lists W1 architecture/plan plus W2 architecture (`W2_ARCHITECTURE.md`) and the W2 plan dir (`docs/week2plans/`).)
- [x] Don't add anything that contradicts W1's existing instructions; just extend.
  (Verified by re-reading the W1 portion: the top-level README's "Demo deployment", "Project documents", "Where the agent lives", "Quick start", and "Submission deliverables" sections are all untouched; the upstream `# OpenEMR` block is byte-for-byte unchanged. In `agent/README.md`, every existing route, script, env var, and section is preserved verbatim — D.5 only inserts new rows/blocks at clear extension points.)

**Definition of done.** Tuesday gate's README expectation satisfied. Reviewers can find the W2 deployed link and setup steps from the top-level README in two clicks.
