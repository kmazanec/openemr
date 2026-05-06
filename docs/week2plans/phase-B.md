# Phase B — Ingestion pipeline + Tier 1/2 persistence

**Status.** Parallel with Phase C. Begin once Phase A is merged.

**Phase summary.** A separate compiled LangGraph app — the ingestion pipeline — produces structured, cited extraction artifacts from a lab PDF or intake form. Six nodes (`rasterize → vision → schemaValidate → patientMatch → persist → emitDeltas`). Tier 1 (DocumentReference in OpenEMR with bytes in DigitalOcean Spaces) and Tier 2 (`extraction_artifacts` row in agent Postgres at `pending_confirmation`) persistence works end-to-end. The pipeline is invokable from three triggers (panel upload, OpenEMR document-upload event in a later phase, CLI replay) but path-A (panel upload during a conversation) is the only invoker wired in this phase. The conversational supervisor's `kickoffExtraction` stub from A.7 is replaced with a real synchronous call into this pipeline; SSE pumps progress events back to the panel. Strict schemas, idempotency on `(document_hash, extractor_version)`, refuse-on-mismatch patient match, and per-extraction LangSmith trace metadata all land in this phase.

No conversational-graph extension lands here — extracting and persisting facts is the entire phase. Citing them in answers and retrieving them by query is Phase C.

**Phase definition of done.**
- Upload a fixture lab PDF through the panel, observe an `extraction_artifacts` row populated in agent Postgres with the strict schema, observe a `DocumentReference` in OpenEMR pointing to bytes in DigitalOcean Spaces, observe the supervisor's `kickoffExtraction` handoff invoked the pipeline end-to-end without manual intervention.
- The same flow works for an intake form fixture, with demographics-delta detection.
- Pipeline failure modes (vision rate-limit, schema-invalid, patient mismatch, oversized doc, corrupted PDF, prompt-injection in scanned text) all produce a typed `failed` artifact and don't poison chart state.
- Per-extraction LangSmith trace metadata (`doc_type`, `page_count`, `extractor_version`, vision token costs, schema warnings, patient-match score, confidence distribution) visible on every pipeline run.
- 26 new pipeline eval cases (8 lab PDF + 8 intake form + 6 degraded + 4 adversarial — see "Eval cases" in `W2_IMPLEMENTATION_PHASES.md` §"Phase B eval cases that land") green in CI against real Anthropic Sonnet 4.x vision.

**Owner.** Me for code; the user for DigitalOcean Spaces bucket + IAM key setup and the `/etc/openemr/.env` population (see `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase B" for the human work).

**Refs.**
- `W2_ARCHITECTURE.md` §"Document Ingestion Pipeline", §"Tiered Persistence" (Tier 1 + Tier 2), §"Failure Modes", §"Observability and Cost".
- `WEEK2-PRESEARCH.md` §W2-3 (cost & latency), §W2-4 (PHI handling), §W2-5 §(2) (pipeline as separate compiled LangGraph), §W2-6 (vision LLM selection), §W2-9 (persistence path), §W2-14 (failure modes), §W2-15 (security).
- Existing patterns: `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/AgentSnapshotController.php` (custom-DAO endpoint pattern with `AgentEndpointAuth`); `agent/src/state/checkpointer.ts` (boot-time table init pattern).

---

## B.0 Human-track prerequisites (gate before any code lands)

**Goal.** All vendor accounts and credentials needed by Phase B are in place on the deployed Droplet and in local `.env` so the engineer can run the pipeline locally and on `emr.biograph.dev` without further account setup.

**Blocked by:** Nothing — this is the user's track and runs in parallel with the engineer's other Phase A wrap-up.
**Unblocks:** Every other Phase B subphase that touches Spaces or vision.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase B".

**Owner.** User (per the parallel human work track).

**Checklist.**
- [x] DigitalOcean Spaces bucket `cdn.biograph.dev` (or chosen name) created in NYC3 (or matched to Droplet region).
- [x] IAM key for OpenEMR (read+write on bucket prefix); separate IAM key for the agent service (read-only on the transient prefix only).
- [x] Lifecycle policy on transient prefix: 24h auto-delete.
- [x] Spaces credentials populated in `/etc/openemr/.env` on the Droplet (per existing secrets-rotation procedure in `RUNBOOK.md`).
- [x] Local `.env.example` updated with the new env var names (`SPACES_BUCKET`, `SPACES_REGION`, `SPACES_OPENEMR_KEY`, `SPACES_OPENEMR_SECRET`, `SPACES_AGENT_KEY`, `SPACES_AGENT_SECRET`, `SPACES_TRANSIENT_PREFIX`). **Do not** put real values in `.env.example`.
- [x] Anthropic billing review: confirm spend cap accommodates ~50 cases × supervisor iterations × CI cadence; recommend $200/mo cap as comfortable ceiling for the W2 sprint.

**Definition of done.** Engineer can run `cd agent && npm run dev` locally with all `SPACES_*` env vars resolved from `.env`, and the deployed Droplet has the same vars in `/etc/openemr/.env`. (Per `feedback_never_read_env_files`, the engineer never reads `.env` directly — confirmation comes from the user.)

---

## B.1 Agent Postgres: `extraction_artifacts` table + idempotency advisory lock

**Goal.** The Tier-2 persistence store exists. The pipeline can claim an advisory lock keyed on `document_uuid` to race-safely handle concurrent invocations.

**Blocked by:** B.0.
**Unblocks:** B.6 (persistence node), C.1 (`documentEvidenceRetriever` reads this table).

**Refs.** `W2_ARCHITECTURE.md` §"Tier 2 — extraction artifact (always lands in agent Postgres)" (full DDL); `agent/src/state/checkpointer.ts` (boot-time table init pattern).

**Files touched.**
- `agent/src/state/extractionArtifacts.ts` (new) — DDL + boot-time initializer + read/write helpers.
- `agent/src/server/index.ts` — call the initializer at boot (mirroring W1's `PostgresSaver.setup()` invocation).

**Checklist.**
- [x] Implement `createExtractionArtifactsTable(connString)` with the exact DDL from `W2_ARCHITECTURE.md` §"Tier 2" (PRIMARY KEY, FK column, indexes, UNIQUE constraint on `(document_hash, extractor_version)`). Idempotent (`CREATE TABLE IF NOT EXISTS`). (Shipped as `createPgExtractionArtifactStore({connectionString}).setup()` mirroring the `scheduleBriefings` / `conversationStore` factory pattern; pool-injectable `createExtractionArtifactStoreFromPool` for tests.)
- [x] Add `claimDocumentLock(connString, documentUuid): Promise<{release: () => Promise<void>}>` using `pg_advisory_lock` keyed on a hash of `documentUuid`. Returns a `release()` that calls `pg_advisory_unlock`. Includes a typed timeout (default 60s) with structured error. (Implementation uses `pg_try_advisory_lock` in a 100ms poll loop — `lock_timeout` does not apply to advisory locks per Postgres docs. SHA-256(documentUuid) → first 8 bytes → signed BigInt is the lock key. Throws `DocumentLockTimeoutError` with documentUuid + timeoutMs on the deadline. `release()` is idempotent.)
- [x] Add `findArtifactByDocumentHash(connString, documentHash, extractorVersion): Promise<ExtractionArtifact | null>` for the idempotency check at pipeline entry.
- [x] Add `insertArtifact(connString, artifact: NewExtractionArtifact): Promise<ExtractionArtifact>` and `updateArtifactStatus(connString, artifactId, status, metadata?)`. (`updateArtifactStatus` uses `COALESCE` so partial metadata updates don't blank existing values; returns null when the artifactId doesn't exist.)
- [x] Wire `createExtractionArtifactsTable(...)` in the `start()` boot sequence in `agent/src/server/index.ts`. Failing to create the table is a hard boot failure (mirrors `PostgresSaver.setup()`).
- [x] Tests: `agent/tests/state/extractionArtifacts.test.ts` covering: idempotent table creation, advisory-lock acquire/release, find-by-hash hit + miss, insert + status-update round-trip. Use a real local Postgres (the existing dev-easy stack's `agent-postgres`) for the integration test. (18 fake-pool unit tests cover deterministic SQL behavior; 3 opt-in integration tests run against `AGENT_TEST_DATABASE_URL` — skipped by default to keep `npm test` host-portable, run locally against the dev-easy `agent-postgres` on port 8330. Race-safety test runs two concurrent claims from independent pools and asserts strict serialization order.)
- [x] PHPStan / ESLint clean. (No PHP touched in B.1; `npm run lint` clean; `npm run typecheck` clean.)

**Definition of done.** Boot logs include "extraction_artifacts table ready" (or equivalent). Round-trip integration test green against the dev Postgres. Concurrent acquire of the same `documentUuid` lock from two test connections proves race-safety.

---

## B.2 DigitalOcean Spaces client + signed-URL minting

**Goal.** The agent service can upload to and read from Spaces with appropriate IAM keys. Single-call, ≤5-min-TTL signed URLs are mintable for vision-call payload delivery. The transient prefix has a 24h lifecycle policy enforced by Spaces.

**Blocked by:** B.0.
**Unblocks:** B.3 (rasterizer uploads to transient prefix), B.6 (Tier-1 persistence stores canonical bytes).

**Refs.** `W2_ARCHITECTURE.md` §"DigitalOcean Spaces" (in §"Component Overview"), §"Spaces signed URLs" (in §"Security and Compliance"); `WEEK2-PRESEARCH.md` §W2-4 (PHI handling — short-TTL signed URLs).

**Files touched.**
- `agent/src/storage/spaces.ts` (new).
- `agent/src/config/env.ts` (or wherever env-var config lives) — add the `SPACES_*` keys.

**Checklist.**
- [x] Pick the AWS SDK v3 (Spaces is S3-compatible). Import `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. Pin to a specific minor version. (Pinned to exact `3.1043.0` for both packages — `--save-exact` so no caret prefix.)
- [x] Implement `createSpacesClient({region, endpoint, accessKey, secretKey})` returning a thin wrapper exposing: `putObject`, `getObject`, `deleteObject`, `presignGetUrl(key, ttlSec)`, `presignPutUrl(key, ttlSec)`. (Wrapper is in `agent/src/storage/spaces.ts`. Signature shape uses an injectable `presign` for testability — production wires the SDK's `getSignedUrl`. TTL is capped at 5 min on both presign methods per W2-4. `getObject` returns a `Buffer` assembled from the SDK stream — handles `Buffer`, `Uint8Array`, the SDK's `transformToByteArray()`, and Node `Readable` shapes.)
- [x] Two clients are constructed at boot: an OpenEMR-side client (read+write, scoped to the bucket prefix) and an agent-side client (read-only on the transient prefix only). Document the IAM-policy expectations in a comment block at the top of the file. (Factories: `createOpenEmrSpacesClient(env)` and `createAgentSpacesClient(env)`. Agent-side client refuses `putObject`/`deleteObject`/`presignPutUrl` locally as defense-in-depth even if the IAM key is misconfigured cloud-side. Boot wiring lives in B.3 alongside the rasterize node — no caller exists yet, so wiring into `start()` is deferred to that subphase.)
- [x] Helper functions: `keyForCanonical(pid, documentUuid, ext)` returns `s3://<bucket>/<pid>/<documentUuid>.<ext>`; `keyForTransientPage(documentUuid, pageNum)` returns `s3://<bucket>/<transientPrefix>/<documentUuid>/page-<pageNum>.png`. (Returned as bare keys — `<pid>/<documentUuid>.<ext>` and `<transientPrefix>/<documentUuid>/page-<n>.png` — without the `s3://<bucket>/` prefix, since the `bucket` is supplied separately to the SDK and adding it twice would double-encode. Helpers reject non-positive pid/page and empty extensions; leading dots on extensions are stripped.)
- [x] Tests: `agent/tests/storage/spaces.test.ts` — unit tests with the AWS SDK mocked. Verify TTL passed correctly to `presignGetUrl`. Integration test (skipped without credentials) that round-trips a small object. (20 tests total — 19 mocked + 1 skipped integration. Integration test gated on `process.env.SPACES_BUCKET` per CLAUDE.md's "Real model in CI" skip semantics.)
- [x] Add `SPACES_*` env vars to `agent/src/config/env.ts` with strict types (per CLAUDE.md "Parse, don't validate" rule). (Lives in `agent/src/config/spacesEnv.ts` — module-per-config-domain instead of a single `env.ts` so future domains add their own parser file. Returns a frozen `SpacesEnv` DTO grouping the OpenEMR + agent IAM credential pairs as nested `SpacesCredentials`. `SPACES_TRANSIENT_PREFIX` defaults to `transient`; rejected when it contains a `/` so callers don't have to second-guess separator handling. Throws `SpacesEnvError` with the failing var name on missing/whitespace values.)

**Definition of done.** Mocked-client unit tests green. Optional integration test round-trips a small object against real Spaces when credentials are present (skipped otherwise per CLAUDE.md "Real model in CI" pattern — same skip semantics).

---

## B.3 Pipeline node 1: `rasterize` — PDF bytes → page PNGs uploaded to transient prefix

**Goal.** Given a PDF in Spaces canonical storage, render each page to a PNG and upload to the transient prefix. Returns a `PageImage[]` with signed-URL references for the next node. Refuse if the per-document cost cap (Q3 — $1.00) would be exceeded by page count × estimated tokens.

**Blocked by:** B.1, B.2.
**Unblocks:** B.4.

**Refs.** `W2_ARCHITECTURE.md` §"Vision call" (transient prefix lifecycle), §"Failure Modes" (Document over $1 cost cap row); `WEEK2-PRESEARCH.md` §W2-3 (cost & latency); §"Open Decisions Carried Forward" Q4b (rasterizer library choice).

**Files touched.**
- `agent/src/pipeline/nodes/rasterize.ts` (new).
- `agent/src/pipeline/index.ts` (new) — pipeline `StateGraph` declaration; this subphase only wires the first node.
- `agent/src/pipeline/state.ts` (new) — `PipelineState` shape per `W2_ARCHITECTURE.md` §"Pipeline as a compiled LangGraph app".

**Checklist.**
- [x] Define `PipelineState` per architecture: `{document_uuid, doc_type, pages: PageImage[], schema: ExtractionSchema | null, artifact_id: string | null, status, errors: PipelineError[]}`. (Shipped at `agent/src/pipeline/state.ts`. `PipelineStatus` is a string-literal union: `'pending' | 'rasterized' | 'extracted' | 'validated' | 'matched' | 'persisted' | 'failed'`. Each downstream node reduces by adding/overwriting its slot via `LastValue<T>` channels — same convention as `agent/src/graph/state.ts`. `triggerSource: 'panel' | 'autosweep' | 'cli'` is carried on state for trace metadata, per W2 §"Three invokers, one pipeline".)
- [x] Pick a rasterizer (per `WEEK2-PRESEARCH.md` Q4b — `pdf2pic` vs `pdfjs-dist + node-canvas` vs `pdf-img-convert`). Decision goes in a top-of-file comment with a one-line rationale. Wrap behind a `Rasterizer` interface so the choice is swappable. (Picked **`pdf-img-convert@2.0.0`** — single-call API, no system binary requirement (unlike `pdf2pic` → GraphicsMagick), prebuilt `canvas` binaries on Node ≥ 18. `Rasterizer` interface in `agent/src/pipeline/rasterizer.ts` exposes `pageCount(pdfBytes)` separately so the cost-cap pre-flight runs against `pdfjs-dist` only and never pays the canvas-render cost on docs we will refuse. Lazy import inside the factory keeps tests that use a stub `Rasterizer` from needing canvas at all.)
- [x] Implement `rasterize(state, deps): Promise<Partial<PipelineState>>`. (Shipped at `agent/src/pipeline/nodes/rasterize.ts`. PDF branch: cost-cap pre-flight (`pageCount × $0.005 > $1.00` → `failed/cost-cap-exceeded`, no render). Image branch: PNG/JPEG/TIFF canonical objects skip rendering — the canonical key itself is presigned as a single page, so transient duplicates only exist for re-rendered PDFs. Unsupported extensions fail with `rasterize_failed`. All `getObject` / `putObject` / `presignGetUrl` failures map to `storage-unreachable`. Constants `ESTIMATED_DOLLARS_PER_PAGE = 0.005`, `PER_DOCUMENT_DOLLAR_CAP = 1.00`, `SIGNED_URL_TTL_SEC = 300` are exported so tests share the same boundary values.)
- [x] Cleanup: pipeline EXIT node (B.7) deletes transient objects on success or terminal failure; the 24h lifecycle policy is the backstop. (Documented at the top of `rasterize.ts`. Cleanup itself ships in §B.7 — out of scope for this subphase.)
- [x] Tests: stub the rasterizer + Spaces client; assert page-count cost cap fires on a 50-page fixture PDF; assert a 3-page PDF rasterizes and uploads. (`agent/tests/pipeline/rasterize.test.ts` — 9 cases: 3-page PDF happy path (uses Chen intake fixture), image-passthrough, cost-cap trip at 250 pages, cost-cap boundary at exactly 200 pages, and 5 failure-isolation cases. `agent/tests/pipeline/rasterizer.test.ts` exercises the real `pdfjs-dist` page-count probe against the seven fixtures; the render path is gated on `RUN_RASTERIZER_RENDER_TESTS=1` because `canvas`'s prebuilt binaries are not always installable in CI. Fixture set lives at `agent/evals/fixtures/document-extraction/source/` (copied from `docs/example-documents/`) with a `manifest.json` the §B.10 eval suite will iterate.)

**Definition of done.** A fixture 3-page PDF runs through `rasterize`, three PNGs land in Spaces transient prefix, the resulting `PageImage[]` carries valid signed URLs (verified by HTTP GET in the integration test).

**New deps.** `pdf-img-convert@2.0.0` (transitively `canvas@2.11.2`, `pdfjs-dist@^4.6.82`); `pdfjs-dist@4.6.82` pinned directly to match the version `pdf-img-convert@2.0.0` is tested against — pinning a newer pdfjs (e.g. `4.10.38`) hoists past `pdf-img-convert`'s transitive resolution and breaks the canvas-bridge render path with `TypeError: Image or Canvas expected`.

**System dependencies (Alpine).** `canvas@2.11.2` has no published prebuilt `linux-musl-x64` binary for node-v127, so `npm ci` builds it from source. CI (`.gitlab-ci.yml` `test:agent` and `test:agent-evals-nightly`) and `agent/Dockerfile` (`deps`, `prod-deps`, `runtime` stages) install: `build-base g++ make python3 pkgconf cairo-dev pango-dev jpeg-dev giflib-dev libjpeg-turbo-dev pixman-dev` (build/dev); `cairo pango jpeg giflib libjpeg-turbo pixman` (runtime only).

---

## B.4 Pipeline node 2: `vision` — Claude Sonnet 4.x with strict schema

**Goal.** Given page images (signed URLs), call Claude Sonnet 4.x via the existing `@langchain/anthropic` SDK with `withStructuredOutput(extractionSchema)`. The model returns per-field bbox + page + quote + self-reported confidence. Extraction schemas are strict-typed for `lab_pdf` and `intake_form` and live next to the node.

**Blocked by:** B.3.
**Unblocks:** B.5.

**Refs.** `W2_ARCHITECTURE.md` §"Vision call" (model selection, structured-output approach), §"Vision prompt-injection defense" (the `<DOCUMENT_PAGE_N>` delimiter); `WEEK2-PRESEARCH.md` §W2-6 (vision LLM selection — Anthropic Sonnet 4.x), §W2-15 (vision prompt-injection defense).

**Files touched.**
- `agent/src/pipeline/nodes/vision.ts` (new).
- `agent/src/pipeline/schemas/labPdf.ts` (new) — Zod schema for lab PDF extraction with `.passthrough()` (per `WEEK2-PRESEARCH.md` §W2-2 / Q2c — `extra='ignore'` semantics).
- `agent/src/pipeline/schemas/intakeForm.ts` (new) — Zod schema for intake form extraction.
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Pipeline/LabPdfExtraction.php` (new) — PHP DTO for OpenEMR-side persistence parity.
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Pipeline/IntakeFormExtraction.php` (new).

**Checklist.**
- [x] Define `agent/src/pipeline/schemas/labPdf.ts` Zod schema:
  - `patient_demographics: { name, dob, sex }` each with `{value, page, bbox, quote, confidence}`.
  - `results: Array<{ panel_code?, analyte_name, value, unit, ref_range_low?, ref_range_high?, abnormal_flag?, collection_date, page, bbox, quote, confidence }>`.
  - `ordering_provider: { name, npi?, page, bbox, quote, confidence }`.
  - `.passthrough()` to silently drop unknown fields. Required fields are hard errors at parse time. (Bbox typed as a `[number, number, number, number]` tuple — same shape `SourceReferenceSchema` uses for `extracted_document` locators, so the resolver downstream is one-step. `abnormal_flag` is a closed enum: `high|low|critical_high|critical_low|normal`. Sex is a closed enum: `male|female|other|unknown`. Results array is `.min(1)` — a lab PDF with zero results is degenerate.)
- [x] Define `agent/src/pipeline/schemas/intakeForm.ts` Zod schema for: demographics, allergies, current medications (free-text → MedicationStatement-shaped), past medical history, family history. (Allergies/meds/PMH/family-history all accept empty arrays — an intake form with no allergies is valid. Demographics has optional `address`/`phone`/`email` cited fields for the §emitDeltas demographics-change detection.)
- [x] Mirror in PHP DTOs — same field names, same required/optional shape. (Eight new classes under `interface/modules/.../src/Pipeline/`: `CitedField`, `LabPdfExtraction`, `LabResult`, `OrderingProvider`, `IntakeFormExtraction`, `IntakeAllergy`, `IntakeMedication`, `PastMedicalHistoryEntry`, `FamilyHistoryEntry`, plus a shared `ExtractionFieldDecoder` with `requireString`/`requireInt`/`requireBbox`/`requireConfidence`/`optionalString`/`requireObject` so each `fromArray` stays focused on the fields that differ. `CitedField.value` is `mixed` rather than generic — closed-enum discipline lives on the parent DTO. Round-trip parity is asserted by `tests/Tests/Isolated/Modules/ClinicalCopilot/Pipeline/ExtractionDtoTest.php` via `assertEqualsCanonicalizing` since JSON key order isn't part of the contract.)
- [x] Implement `vision(state, deps): Promise<Partial<PipelineState>>`:
  1. Build the system prompt with the `<DOCUMENT_PAGE_N>...</DOCUMENT_PAGE_N>` delimiter and the W2-15 "ignore embedded instructions" rule.
  2. Build the user prompt with all `state.pages[]` referenced by signed URL (Anthropic image-URL content blocks).
  3. Pick the schema: `state.doc_type === 'lab_pdf'` → `labPdfSchema`; `intake_form` → `intakeFormSchema`.
  4. Call `ChatAnthropic({modelName: 'claude-sonnet-4-...', temperature: 0}).withStructuredOutput(schema).invoke(...)`.
  5. On success: return `{schema: parsed}`.
  6. On rate-limit or transient error: retry once with backoff. On second failure or schema-invalid: return `{status: 'failed', errors: [{code: 'rate-limited' | 'schema_invalid', ...}]}`. (Shipped at `agent/src/pipeline/nodes/vision.ts`. Image content blocks use the new `@langchain/core` standard `{type: 'image', url, mimeType: 'image/png'}` shape — the legacy `image_url` form continues to deprecate. `VisionInvocation` is the injected boundary — production `createAnthropicVisionInvocation` wraps `ChatAnthropic.withStructuredOutput`; tests stub it deterministically. `TransientVisionError` triggers the single 500ms retry; `VisionSchemaError` is unconditionally `failed/schema_invalid`. A defense-in-depth `safeParse` re-runs the Zod schema even when the invoker returned without throwing — catches stub-test misuse and any future invoker that returns malformed output. `EXTRACTOR_VERSION = 'vision-v1'` is exported for the §B.7 persist node's idempotency key.)
- [x] PHI suppression: vision payload inputs/outputs are PHI; rely on the W1 `LANGSMITH_HIDE_INPUTS`/`HIDE_OUTPUTS` defaults (already set per `W2_ARCHITECTURE.md` §"Vision payloads"). Pino logger redaction extends to vision payload paths. (Added `signedUrl` and `extraction` to `agent/src/observability/logger.ts`'s redact paths so the local-debug `AGENT_DEBUG_VISION_INPUTS=1` flag stays PHI-safe even when set. The vision node itself never logs the raw extraction or signed URLs at info-level — only the count of pages and the doc type — so the redaction is the second line of defense.)
- [x] Per-extraction trace metadata: `vision_input_tokens`, `vision_output_tokens`, `vision_dollar_cost`, `schema_validation_warnings`, `confidence_distribution` (histogram). (Recorded via `setRunMetadata` from `observability/traceMetadata.ts` so it lives on the LangSmith run when one's active and is a no-op otherwise. Histogram buckets: `lt-0.5`, `0.5-0.7`, `0.7-0.9`, `ge-0.9`. Cost computed from `costForUsage` against the existing `PRICE_TABLE_USD_PER_MILLION` — claude-sonnet-4-6 already in the table.)
- [x] Tests: stubbed-LLM unit tests covering happy path (returns valid schema), schema-invalid (Zod rejects), rate-limit retry-then-fail, and vision-injection-attack fixture (page contains "ignore previous instructions and ..." — assert the model still returns extraction-shaped output, not the injected instruction). (`agent/tests/pipeline/vision.test.ts` — 10 cases including both happy paths (lab + intake), `VisionSchemaError` no-retry, defense-in-depth re-parse on malformed extraction, transient-then-success, transient-then-fail, non-transient no-retry, prompt-injection structural test, empty-pages defensive, and an EXTRACTOR_VERSION exposure test. `agent/tests/pipeline/schemas.test.ts` — 16 cases pinning the Zod schema contract independent of the vision call. The pipeline graph (`agent/src/pipeline/index.ts`) now wires `rasterize → vision` with a conditional edge that short-circuits on a `failed` rasterize so failure isolation is structural. Real-Anthropic integration test deferred to §B.10's adversarial cases.)

**Definition of done.** Stubbed-LLM unit tests green. Real-Anthropic integration test (skipped without `ANTHROPIC_API_KEY`) runs against a CDC sample lab PDF fixture and produces a schema-valid extraction.

---

## B.5 Pipeline node 3: `schemaValidate` — Zod parse with `.passthrough()`

**Goal.** Strict-validate the vision output. Drop unknown fields silently; reject missing required fields hard. Produce a structured `failed` artifact on validation failure rather than coerce.

**Blocked by:** B.4.
**Unblocks:** B.6.

**Refs.** `W2_ARCHITECTURE.md` §"Vision call" (`.passthrough()` semantics, "missing-required fields are hard errors"); `WEEK2-PRESEARCH.md` §W2-2 (Q2c — schema strictness `extra='ignore'`).

**Files touched.**
- `agent/src/pipeline/nodes/schemaValidate.ts` (new).

**Checklist.**
- [x] Implement `schemaValidate(state, deps): Partial<PipelineState>`:
  1. Pick the schema by `state.doc_type` (same dispatch as `vision`).
  2. Run `schema.safeParse(state.schema)` — note that `state.schema` was already typed at vision time, this is a defense-in-depth re-validation post-LLM.
  3. On success: pass through (state unchanged).
  4. On parse failure: return `{status: 'failed', errors: [{code: 'schema_invalid', message, path}]}`. (Shipped at `agent/src/pipeline/nodes/schemaValidate.ts`. Kept synchronous — the node has no I/O — but LangGraph still accepts the return as a node action; the graph wiring stays uniform with `rasterize` / `vision`. A null `state.schema` is treated as `schema_invalid` rather than crashing, so the node is safe to call even when invoked out-of-order. Issue paths surface as `{path, message}` strings under `errors[0].details.issues`, matching the shape vision uses for its own defense-in-depth check.)
- [x] Bbox-required defense: if any cited field is missing `page` or `bbox`, the field is dropped during validation (strict-schema requires bbox + page on every cited field per `W2_ARCHITECTURE.md` §"Failure Modes" "Bbox missing for a field" row). (Implemented as a recursive `sanitizeBboxMissing` walk that runs **before** the strict `safeParse`. A "cited field" is detected structurally by the presence of `quote: string` + `confidence: number`; a cited-shaped object lacking `bbox` (4-tuple of finite numbers) or `page` (positive int) is removed — as an array element or as an object key. The walk preserves non-cited containers (the demographics object, the extraction root) and recurses into them. Required cited fields that get dropped still fail strict-parse downstream — that's the right behavior, the fact wasn't extractable.)
- [x] Tests: pass-through happy path; schema-invalid case; bbox-missing case (asserts the field is dropped, not the whole extraction). (`agent/tests/pipeline/schemaValidate.test.ts` — 8 cases: lab+intake happy paths, missing-required-field, null-schema, array-element bbox-missing → drops only that element, optional-field bbox-missing → drops only that field, **required**-field bbox-missing → fails (proves we don't silently drop required structure), and `min(1)` array fully sanitized to empty → fails. Wired into the pipeline graph via `vision → schemaValidate → END` with the same `routeOrFail` short-circuit on `failed` upstream.)

**Definition of done.** Unit tests green. Validation failure produces a `failed` artifact with structured error path; partial schemas are never accepted.

---

## B.6 Pipeline node 4: `patientMatch` — refuse on confident mismatch

**Goal.** Compare extracted demographics (name, DOB) against the chart's demographics for the supplied `pid`. Confident match → proceed. Confident mismatch → refuse with `failed` artifact. Partial match → flag the artifact's `confidence_signal` as "partial patient match" for the verifier's downstream Q14 hard-stop logic.

**Blocked by:** B.5.
**Unblocks:** B.7.

**Refs.** `W2_ARCHITECTURE.md` §"Patient match" (the three-bucket disposition); `WEEK2-PRESEARCH.md` §W2-15 (security — wrong-patient document refuse).

**Files touched.**
- `agent/src/pipeline/nodes/patientMatch.ts` (new).
- `agent/src/pipeline/match/demographics.ts` (new) — pure-function name + DOB matchers.

**Checklist.**
- [ ] Implement `matchName(extracted, chart): MatchScore` with a structural matcher: exact match (case-insensitive) → 1.0; same surname + same first-name initial → 0.6; otherwise → 0.0. (Fuzzy logic is a follow-up — keep the structural matcher simple and predictable for evals.)
- [ ] Implement `matchDob(extracted, chart): MatchScore` — exact match → 1.0; off by one day → 0.5 (typo-shaped); otherwise → 0.0.
- [ ] Implement `patientMatch(state, deps): Promise<Partial<PipelineState>>`:
  1. Fetch chart demographics for `pid` via the existing snapshot client (`agent/src/tools/getPatientContext.ts`).
  2. Compute name and DOB scores. Combine into a per-pipeline `confidence_signal: { patient_match_score, demographics_warnings }`.
  3. Confident match (both 1.0) → pass through with `confidence_signal` written to state.
  4. Confident mismatch (either 0.0) → `{status: 'failed', errors: [{code: 'patient_mismatch', mismatch_reason}]}`.
  5. Partial match (0.5–1.0) → pass through with `confidence_signal.patient_match_partial = true`.
- [ ] Tests: three buckets — exact match, off-by-one DOB, completely different name.

**Definition of done.** Unit tests green. Cross-patient document fixture refuses at this node and produces `failed` artifact with `mismatch_reason`.

---

## B.7 Pipeline nodes 5+6: `persist` (Tier 1 + Tier 2) and `emitDeltas`

**Goal.** Tier 1 (DocumentReference in OpenEMR pointing to canonical Spaces bytes) and Tier 2 (`extraction_artifacts` row with full extraction JSON) write atomically. The diff between extracted facts and chart state is computed and stored as `deltas_json` for the UI's needs-confirmation chips. Pipeline EXIT cleans up transient Spaces objects.

**Blocked by:** B.1, B.2, B.6.
**Unblocks:** B.8 (the OpenEMR-side endpoint that triggers the pipeline), C.1 (`documentEvidenceRetriever` reads Tier 2).

**Refs.** `W2_ARCHITECTURE.md` §"Persistence (Tier 1 + Tier 2)", §"emitDeltas"; `WEEK2-PRESEARCH.md` §W2-9 (persistence path).

**Files touched.**
- `agent/src/pipeline/nodes/persist.ts` (new) — writes Tier 2; calls into OpenEMR for Tier 1.
- `agent/src/pipeline/nodes/emitDeltas.ts` (new).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DocumentReferenceWriteService.php` (new) — thin wrapper over OpenEMR's existing FHIR DocumentReference write.
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/document_reference.php` (new) — system-actor-authenticated endpoint exposed to the agent service for the Tier-1 write (per `feedback_agent_uses_custom_dao_endpoints` — never extend `/fhir/`).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentReferenceController.php` (new).

**Checklist.**
- [ ] **Tier 1 — OpenEMR-side DocumentReference writer (PHP):**
  - `DocumentReferenceWriteService::write(pid, documentUuid, doctype, spacesUrl): string` returns the `DocumentReference` UUID.
  - Internally writes to the existing `documents`/FHIR DocumentReference path with `subject = Patient/{uuid}`, `category = lab` or `intake`, `content.attachment.url = spaces://...`. Fires existing `documents.post_insert` event.
  - Categorizes via OpenEMR's `categories` / `categories_to_documents` so the document shows up in the existing document UI.
  - PHPStan level 10 clean.
- [ ] **The Tier-1 endpoint (PHP):** `public/snapshot/document_reference.php` — POST endpoint that takes `{pid, document_uuid, doc_type, spaces_url}`, behind `AgentEndpointAuth` (matches the W1 snapshot-endpoint pattern). Calls `DocumentReferenceWriteService::write`. Returns the `DocumentReference` UUID. Per-call ACL check identical to other agent endpoints.
- [ ] **Tier 2 — agent-side extraction artifact write (TS):**
  - `persist(state, deps)`:
    1. Compute `document_hash` (SHA-256 of canonical bytes).
    2. Idempotency lookup: `findArtifactByDocumentHash(connString, document_hash, EXTRACTOR_VERSION)` — if hit, return cached `artifact_id` without writing.
    3. Else: claim advisory lock on `document_uuid`. Call the OpenEMR Tier-1 endpoint to write the DocumentReference. Then `insertArtifact(...)` with full schema, deltas (computed in `emitDeltas`), `confidence_signal` (from `patientMatch`), `status: 'pending_confirmation'`, `document_hash`. Release lock.
    4. Return `{artifact_id, status: 'persisted'}`.
- [ ] **emitDeltas:** Walk extracted facts vs chart state. Output `deltas_json` per the architecture: `{new_allergies: [...], new_diagnoses: [...], new_medications: [...], demographics_changes: [...]}`. Stored as a column on the artifact row.
- [ ] **EXIT cleanup:** delete transient Spaces objects on success. (24h lifecycle policy is the backstop if the cleanup fails.)
- [ ] Tests: end-to-end pipeline test with a fixture lab PDF — assert Tier-1 row in OpenEMR, Tier-2 row in agent Postgres, deltas computed, transient prefix cleaned. Idempotency test — re-run same input, assert same `artifact_id` returned without re-writing.

**Definition of done.** Fixture lab PDF runs through the full 6-node pipeline. Both rows visible in their respective databases. Re-running the pipeline against the same input is a no-op (returns cached `artifact_id`).

---

## B.8 OpenEMR-side endpoint: `public/snapshot/extract.php` — pipeline trigger

**Goal.** The conversational supervisor's `kickoffExtraction` handoff sends a request to OpenEMR; OpenEMR validates, mints the agent's JWT, calls the agent's pipeline-trigger endpoint synchronously, streams progress back over SSE.

**Blocked by:** B.7.
**Unblocks:** B.9 (replace the supervisor stub).

**Refs.** `W2_ARCHITECTURE.md` §"Three invokers, one pipeline" (path A — panel upload during conversation); `WEEK2-PRESEARCH.md` §W2-5 §(2) ("`await pipelineGraph.invoke(...)` synchronously, pumps progress events back over SSE"); existing endpoint pattern at `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/AgentSnapshotController.php`.

**Files touched.**
- `interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/extract.php` (new).
- `interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/ExtractController.php` (new).
- `agent/src/server/routes/extract.ts` (new) — the agent-side route the OpenEMR controller calls.

**Checklist.**
- [ ] **PHP endpoint:** `public/snapshot/extract.php` accepts POST `{pid, document_uuid, doc_type, trigger_source: 'panel'}`. Bootstraps OpenEMR session, applies the existing `AgentEndpointAuth`, dispatches to `ExtractController`. Mints an agent JWT scoped to the pipeline. Calls the agent's `/v1/agent/extract` route via streaming. Pipes the resulting SSE stream back to the caller (panel UI).
- [ ] **Agent-side route:** `agent/src/server/routes/extract.ts` — Hono route that validates the JWT, parses `{pid, document_uuid, doc_type, trigger_source}`, calls the compiled pipeline graph (`pipelineGraph.invoke({...})`). Streams progress events as SSE: `pipeline.start`, `pipeline.rasterize.complete`, `pipeline.vision.complete`, `pipeline.persist.complete`, `pipeline.exit` (with final `artifact_id`). Errors stream as `pipeline.error` with `{code, message}`.
- [ ] Per-pipeline LangSmith trace metadata recorded (`doc_type`, `page_count`, `extractor_version`, `trigger_source: 'panel'`, vision token costs, schema warnings, `patient_match_score`, `confidence_distribution`).
- [ ] Tests: PHP isolated test for `ExtractController` (auth + dispatch, no real agent call). Agent-side Vitest with the pipeline mocked to assert SSE event sequence on happy path + on each failure mode.

**Definition of done.** `curl -X POST /interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/extract.php` from inside an authenticated OpenEMR session triggers the pipeline and streams events back. Failure modes produce `pipeline.error` SSE events.

---

## B.9 Replace the `kickoffExtraction` stub with the real synchronous pipeline call

**Goal.** The supervisor's `kickoffExtraction` handoff (no-op stub from A.7) is replaced with a real synchronous call into the pipeline. The supervisor's args carry `{document_uuid, doc_type}` from the envelope; the pipeline runs end-to-end; the supervisor sees the resulting artifact in subsequent state.

**Blocked by:** A.7 (the stub exists), B.7 (pipeline runs end-to-end), B.8 (the trigger endpoint).
**Unblocks:** Phase D (end-to-end thin slice).

**Refs.** `W2_ARCHITECTURE.md` §"Conversational graph" (the `kickoffExtraction` arrow), §"Three invokers, one pipeline" (path A); `WEEK2-PRESEARCH.md` §W2-5 §(2).

**Files touched.**
- `agent/src/graph/nodes/kickoffExtraction.ts` — replace the stub with the real implementation.
- `agent/src/graph/state.ts` — add `extractionArtifacts: ExtractionArtifact[]` slot if not present.

**Checklist.**
- [ ] Implement the real `kickoffExtraction(state, args, deps)`:
  1. Validate `args: { document_uuid: string, doc_type: 'lab_pdf' | 'intake_form' }` via Zod.
  2. Call `pipelineGraph.invoke({pid: envelope.pid, document_uuid: args.document_uuid, doc_type: args.doc_type, trigger_source: 'panel'})`.
  3. Pump pipeline progress events to the conversation's SSE stream so the panel renders "Extracting document…".
  4. On pipeline success: append the resulting `ExtractionArtifact` (or its summary projection) to `state.extractionArtifacts`. Return control to supervisor.
  5. On pipeline failure: append a `failed`-status artifact summary to `state.extractionArtifacts` with the error code. Return control to supervisor — supervisor sees the failed-artifact state and routes around it (per `W2_ARCHITECTURE.md` §"Failure isolation").
- [ ] Update the supervisor's handoff manifest (in A.7's prompt) to describe `kickoffExtraction` honestly: when to invoke it (envelope carries unprocessed `document_uuid`), what args to pass.
- [ ] Tests: stubbed-pipeline unit test covering happy-path artifact append, failure-path failed-artifact append. End-to-end test with real pipeline against a fixture lab PDF (real Anthropic if creds present, skipped otherwise).

**Definition of done.** Phase B's "Phase definition of done" first bullet (upload fixture lab PDF, see populated `extraction_artifacts` row, see DocumentReference, see supervisor's `kickoffExtraction` handoff produce the artifact) is demoable end-to-end. Failure-mode artifacts visible in agent Postgres and the supervisor doesn't poison chart state.

---

## B.10 Pipeline eval cases — 26 cases land in CI

**Goal.** All 26 Phase B eval cases (per `W2_IMPLEMENTATION_PHASES.md` §"Phase B eval cases that land") pass real-model in CI. These are the pipeline-only cases — citation-in-answer cases come in C and D.

**Blocked by:** B.4, B.7, B.9.
**Unblocks:** Phase D end-to-end (which combines B + C).

**Refs.** `W2_ARCHITECTURE.md` §"Eval Architecture" (real-model-in-CI rationale, boolean rubrics); `W2_IMPLEMENTATION_PHASES.md` Phase B "Eval cases that land in B".

**Files touched.**
- `agent/evals/runners/documentExtractionSuite.ts` (new) — the new W2 suite.
- `agent/evals/runners/suites.ts` — add the new suite.
- `agent/evals/runners/regenerate-document-extraction.ts` (new) — fixture generator.
- `agent/evals/cases/document-extraction/{lab-pdf,intake-form,degraded,adversarial}/*.test.ts` (new).
- `agent/evals/fixtures/document-extraction/` (new — generated PDFs / images for fixtures).

**Checklist.**
- [ ] **Lab PDF extraction (8 cases):** clean scans across the seeded archetypes; one with multi-panel results; one with low-quality scan that survives extraction. Each case asserts `schema_valid` (Zod parse), `citation_present` (every claim has bbox + page + quote), `factually_consistent` (verifier accepts on follow-up turn).
- [ ] **Intake form extraction (8 cases):** clean intake forms covering each archetype's demographics shape; one with the demographics-delta detection (Q2b — address change, new allergy not on chart).
- [ ] **Degraded inputs (6 cases):** smudged, rotated, blank, unrelated document, partial intake, OCR-grade-bad scan. Verifier rejects low-confidence claims; UI surfaces Gap chips. Allergy-category fail-closed asserted on the partial-intake case.
- [ ] **Adversarial (4 cases):** wrong-patient document refuse (`patient_mismatch`); prompt-injection inside scanned text ignored (`schema_valid` despite injection); oversized document hits the $1 cap (`cost-cap-exceeded`); corrupted PDF bytes fail safely (`schema_invalid` or `rasterize` failure code).
- [ ] All 26 cases use **real** Anthropic Sonnet 4.x in CI per `W2_ARCHITECTURE.md` §"Real model in CI for all 50 cases". Stubbed versions for the developer's inner loop live under `agent/evals/cases/document-extraction/stubbed/`.
- [ ] Per-rubric baseline file `agent/evals/baselines/document_extraction_v1.json` committed (lands in E with the CI gate; for B just include the boolean per case).
- [ ] Run `npm test` against stubbed; run `npm run evals:experiment` against real model when credentials present.

**Definition of done.** All 26 cases green against stubbed and (when credentials present) against real model. Suite registered in `suites.ts` so the experiment runner picks it up. Trace metadata visible in LangSmith for each real-model run.
