# Phase C — Conversational supervisor extensions + retrievers + USPSTF corpus

**Status.** Parallel with Phase B. Begin once Phase A is merged.

**Phase summary.** The LLM supervisor's W2 handoffs become real. Two new retriever nodes — `documentEvidenceRetriever` (over `extraction_artifacts`) and `evidenceRetriever` (hybrid sparse-dense over Pinecone with Cohere rerank) — replace their A.7 no-op stubs. The USPSTF corpus is curated, embedded with OpenAI `text-embedding-3-large`, and indexed in Pinecone with sparse BM25 vectors via `pinecone-text`. The synthesizer's prompt extends to handle three source types and to wrap retriever outputs in delimited tags. The verifier extends with per-`source_type` resolution rules (extracted-document checks bbox + page + quote against recorded extraction; guideline checks chunk-id-in-this-turn + quote substring match). Confidence hard-stops are wired in `agent/src/verify/confidenceThresholds.ts`. The format node groups claims by source type for the panel UI.

This phase doesn't touch the ingestion pipeline (that's B) and doesn't ship the panel UI for chips (that's D for the minimal version, F for full polish). The deliverable is "ask a clinical question, see all three source types resolve in LangSmith."

**Phase definition of done.**
- Ask the agent a clinical question against a seeded archetype.
- See the supervisor's iterations in LangSmith with closed-enum decisions and rationale per iteration.
- See the supervisor invoke `evidenceRetriever` with a model-picked query.
- See USPSTF chunks returned with rerank scores from `evidenceRetriever`.
- See a guideline claim cited in the synthesizer's output.
- See the verifier resolve the claim against the retriever's output.
- See the format node group claims into "What's in the chart" / "From documents" / "Evidence" sections.
- 12 new conversational-graph eval cases (per `W2_IMPLEMENTATION_PHASES.md` Phase C eval cases) green in CI.

**Owner.** Me for code; the user for Pinecone + OpenAI + Cohere account setup and `/etc/openemr/.env` population (see `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase C").

**Refs.**
- `W2_ARCHITECTURE.md` §"documentEvidenceRetriever", §"evidenceRetriever", §"Synthesize", §"Verify", §"Format", §"Hard stops on extraction confidence (Q14)".
- `WEEK2-PRESEARCH.md` §W2-7 (hybrid RAG design — Pinecone sparse-dense + Cohere rerank), §W2-8 (citation contract), §W2-10 (verification design extensions), §W2-11 (observability extensions).
- Existing patterns: `agent/src/graph/nodes/synthesize.ts` (current synthesizer), `agent/src/verify/verifier.ts` (current verifier).

---

## C.0 Human-track prerequisites (gate before any code lands)

**Goal.** Pinecone, OpenAI, Cohere accounts + API keys populated so the engineer can run the new retrievers locally and on `emr.biograph.dev`.

**Blocked by:** Nothing.
**Unblocks:** C.2, C.3, C.4.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` §"Required by Phase C".

**Owner.** User.

**Checklist.**
- [x] Pinecone account + API key. Region `us-east-1` (default) is fine. Free tier or starter tier sufficient for the MVP corpus (~50–80 USPSTF chunks).
- [x] OpenAI account + API key with embeddings access. Set a billing cap (belt-and-suspenders).
- [x] Cohere account + API key with `rerank-3` access. Free trial credits typically sufficient for the W2 sprint.
- [x] All three keys populated in `/etc/openemr/.env` on the Droplet. Local `.env.example` updated with the new env-var names: `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `PINECONE_NAMESPACE` (defaults to `guidelines-v1`), `OPENAI_API_KEY`, `COHERE_API_KEY`.

**Definition of done.** Engineer has all three keys resolvable from `.env` locally and the user confirms they're on the Droplet. (Per `feedback_never_read_env_files`, engineer never reads `.env` directly — confirmation via the user.)

---

## C.1 `documentEvidenceRetriever` — per-patient retrieval over `extraction_artifacts`

**Goal.** Replace the A.7 no-op stub with a real query over the `extraction_artifacts` table (filtered by `pid`, `status`, `doc_types`, `lookback_days`, semantic relevance to the supervisor's `query`). Returns `ExtractedFactSnippet[]` with bbox + page + quote + field path. Each snippet maps directly onto a `SourceReference` with `source_type='extracted_document'`.

**Blocked by:** B.1 (the table exists). Can run in parallel with the rest of Phase B since it only reads.
**Unblocks:** C.5 (verifier consumes), C.7 (eval cases).

**Refs.** `W2_ARCHITECTURE.md` §"documentEvidenceRetriever" (full args schema, filter logic, return shape); `WEEK2-PRESEARCH.md` §W2-9 (extraction artifacts).

**Files touched.**
- `agent/src/graph/nodes/documentEvidenceRetriever.ts` — replace stub.
- `agent/src/state/extractionArtifacts.ts` — add `searchArtifacts(filters): Promise<readonly ExtractionArtifact[]>`.
- `agent/src/graph/types.ts` — `DocumentEvidenceArgsSchema`, `ExtractedFactSnippet` (added during build; supervisor narrowing needs the typed shape).
- `agent/src/graph/state.ts` — new `documentEvidenceArgs` and `documentEvidenceSnippets` slots so the supervisor can hand off args and the node can return snippets the C.5 verifier will consume.
- `agent/src/graph/nodes/supervisor.ts` — `narrowDocumentEvidenceArgs` mirroring `narrowRetrieveChartArgs`.
- `agent/src/graph/index.ts` — wire `createDocumentEvidenceRetriever` (deps optional; falls back to A.7 stub for tests that don't supply a store).
- `agent/src/observability/traceMetadata.ts` — export `tagSalt` so the retriever can hash its model-picked query for PHI-safe trace metadata.
- `agent/src/graph/followUps.ts` — export the existing `MS_PER_DAY` constant (reuse rather than redefine).

**Checklist.**
- [x] Define args Zod schema:
  ```ts
  const DocumentEvidenceArgs = z.object({
    query: z.string().min(1),
    doc_types: z.enum(['lab_pdf', 'intake_form']).array().optional(),
    lookback_days: z.number().int().min(1).max(3650).default(90),
    top_k: z.number().int().min(1).max(20).default(5),
  });
  ```
  (Implemented as `DocumentEvidenceArgsSchema` in `agent/src/graph/types.ts`. `doc_types` lower bound is `min(1)` so an empty array can't slip past structured-output coercion.)
- [x] Implement the read helper `searchArtifacts({pid, since, docTypes?}): Promise<readonly ExtractionArtifact[]>`:
  - `WHERE pid = $pid` — non-negotiable; the model cannot widen scope.
  - `AND status = ANY($SEARCHABLE_STATUSES)` (rejected/superseded/failed excluded).
  - Optional `AND doc_type = ANY($docTypes)`.
  - `AND created_at >= $since`.
  - Order by `created_at DESC`.
- [x] Implement the node `documentEvidenceRetriever(state)` that reads args from `state.documentEvidenceArgs`, calls `searchArtifacts`, projects facts to snippets, ranks them by `keywordScore + recencyBonus`, and writes the top-`top_k` to `state.documentEvidenceSnippets`.
- [x] `ExtractedFactSnippet` projection covers `{artifactId, documentUuid, docType, fieldPath, value, page, bbox, quote, confidence?, extractorVersion, createdAt}` — every field C.5's verifier needs to resolve an `extracted_document` `SourceReference`. The bbox/page/quote map directly onto `SourceReference.locator`; `extractorVersion` and `documentUuid` map onto `meta`. (The full `SourceReference` projection itself lands in C.5 alongside the verifier's `extracted_document` resolution rule — synth/verify don't yet read snippets.)
- [x] Per-call LangSmith trace metadata: `doc_query_hash` (HMAC-SHA256-12 via shared `hashIdForTrace` + `tagSalt`), `doc_types`, `doc_lookback_days`, `doc_top_k`, `doc_artifact_count`, `doc_candidate_count`, `doc_dropped_candidate_count`, `doc_returned_count`, `latency_ms`. Plus a structured pino warning when `dropped_candidate_count > 0` so schema drift surfaces in logs as well as traces.
- [x] Tests: stubbed-data unit tests covering: searchArtifacts always passes `pid` to the SQL filter and rejects empty `docTypes`; the node throws when the supervisor routes to it without populating args; doc_types filter narrows; top-k respected; matching snippets surface above irrelevant fresher ones (keyword + recency); empty matching set returns `[]` not `null`; drift-shaped fact-leaves drop. Supervisor narrowing tests pin the structured-output → typed-slot path.

**Definition of done.** A fixture patient with three persisted lab artifacts → supervisor invokes `documentEvidenceRetriever({query: 'recent A1c', doc_types: ['lab_pdf'], top_k: 3})` → three snippets returned with valid `SourceReference` projections.

---

## C.2 USPSTF corpus + `evals:reindex-corpus` script

**Goal.** All published USPSTF recommendations are fetched verbatim from the publisher to a local cache, parsed deterministically into per-section chunk files, and indexed into Pinecone with metadata. Idempotent and re-runnable at each step.

**Blocked by:** C.0.
**Unblocks:** C.3 (the retriever needs an indexed corpus to query against), C.7.

**Refs.** `W2_ARCHITECTURE.md` §"evidenceRetriever" (corpus curation, metadata shape); `WEEK2-PRESEARCH.md` §W2-7 (hybrid RAG design — Pinecone sparse-dense + Cohere rerank, embedding model selection); §"Open Decisions Carried Forward" Q9 (corpus expansion sequence).

**Approach (revised in implementation).** ~~Single curate-and-reindex script that ingests ~50–80 hand-picked chunks aligned to the W1 archetypes.~~ Two-step pipeline so the network-bound fetch is decoupled from the deterministic transform: `corpus:fetch:uspstf` downloads every published recommendation HTML to a local gitignored cache (`agent/.corpus-cache/uspstf/`); `corpus:extract:uspstf` parses cached HTML with `cheerio` and emits one chunk file per `(recommendation, section)` under `agent/data/corpus/uspstf/`; `evals:reindex-corpus` is source-agnostic from the start and iterates `agent/data/corpus/*/`. The corpus is bounded by what the publisher has, not by archetype hand-picking — all published USPSTF recommendations get indexed. **No model-authored text in the corpus**: every chunk's body is verbatim from the publisher's HTML; selectors that fail are skipped and logged for manual review, never filled in by the model.

**Files touched.**
- `agent/data/corpus/uspstf/index.json` (new) — manifest of generated chunks (auto-emitted by `extract`).
- `agent/data/corpus/uspstf/<slug>--<section>.md` (new — one file per chunk) — chunk text plus YAML frontmatter with `{publication, year, section, url, license_tier, ...}`.
- `agent/scripts/fetch-uspstf-corpus.ts` (new) — fetches all USPSTF recommendation HTML into `agent/.corpus-cache/uspstf/`.
- `agent/scripts/extract-uspstf-corpus.ts` (new) — parses cached HTML into committed chunk files.
- `agent/scripts/reindex-corpus.ts` (new) — embeds + upserts chunks to Pinecone.
- `agent/package.json` — `corpus:fetch:uspstf`, `corpus:extract:uspstf`, `evals:reindex-corpus` script aliases. `cheerio` added as a dependency.
- `.gitignore` — `agent/.corpus-cache/`.

**Checklist.**
- [x] Add `cheerio@^1.0.0` to `agent/package.json` dependencies (HTML parsing for extract). Add `agent/.corpus-cache/` to `.gitignore`. (Pinned `cheerio@1.2.0`; same chore commit added the other corpus deps — `gray-matter@4.0.3`, `@pinecone-database/pinecone@7.2.0`, `openai@6.36.0`, `natural@8.1.1` + `@types/natural`. `agent/.corpus-cache/` gitignored at repo root.)
- [x] Implement `agent/scripts/fetch-uspstf-corpus.ts`:
  1. Discover all published USPSTF recommendation slugs from the topic-index page(s) at `https://www.uspreventiveservicestaskforce.org/uspstf/topic_search_results?topic_status=P`.
  2. For each slug, GET the recommendation page and write the response body to `agent/.corpus-cache/uspstf/<slug>.html`.
  3. Persist `agent/.corpus-cache/uspstf/manifest.json` with `{slug, url, fetched_at, content_sha256}` per recommendation. Re-runs skip when `content_sha256` matches what's already on disk.
  4. Polite crawl: single-threaded, ~1 req/sec rate-limit, descriptive User-Agent, respect robots.txt. (Honors the publisher's `Crawl-delay: 5`, paced at 5.5s/request. Pagination uses `?PAGE=N`. 108 active recommendations fetched in ~10 min.)
- [x] Implement `agent/scripts/extract-uspstf-corpus.ts`:
  1. Read `agent/.corpus-cache/uspstf/manifest.json` and walk every cached HTML file.
  2. With `cheerio`, extract: title, publication date (year), grade, population, "Recommendation Summary" body, "Clinical Considerations" body. The body text is taken verbatim from the page DOM — no rewrites, no summarization.
  3. Write one chunk file per non-empty section to `agent/data/corpus/uspstf/<slug>--<section>.md` with YAML frontmatter `{publication: 'USPSTF', year, section, url, license_tier: 'public_domain', title, grade?, population?}` and the verbatim body in markdown.
  4. Regenerate `agent/data/corpus/uspstf/index.json` from the filesystem (sorted, stable).
  5. Selectors that fail on a page: log a structured warning and skip that page; do not invent content. Exit code is 0 even with warnings (so re-running after a selector fix is the recovery path). (Selectors target stable USPSTF anchors: `script[type=application/ld+json]` for headline/datePublished/url/articleSection; `.field--name-field-recommendation-summary` for the population/grade table; `div[id="<section title>"]` per articleSection name. `SECTION_MAP` pins recommendation-summary, importance, assessment-of-net-benefit, practice-considerations, clinical-considerations. Output: 300 chunks across 90 active recommendations; 18 inactive/legacy pages produced no chunks because the publisher has no parseable structured guidance there.)
- [x] Implement `agent/scripts/reindex-corpus.ts` (source-agnostic from the start so ADA / ACC-AHA / etc. plug in by adding a corpus directory later):
  1. Iterate `agent/data/corpus/*/index.json` to get the chunk list per source.
  2. For each chunk file: parse frontmatter, embed body via OpenAI `text-embedding-3-large` (3072d), compute BM25 sparse vector via ~~`pinecone-text` SDK~~ inline BM25 (`pinecone-text` is Python-only; we ship the Robertson formula inline with `natural`'s WordTokenizer + FNV-1a token hashing — same Pinecone hybrid sparse-vector format) fitted on the corpus body texts.
  3. Upsert to Pinecone hybrid index with metadata `{publication, year, section, url, license_tier, source, title}` in namespace `guidelines-v1`.
  4. Idempotent: stable chunk IDs (`<source>::<basename>` of the chunk file); re-running upserts in place rather than appending.
- [x] Add scripts to `agent/package.json`: `"corpus:fetch:uspstf"`, `"corpus:extract:uspstf"`, `"evals:reindex-corpus"`.
- [x] No-op without credentials: `reindex-corpus.ts` exits 0 with a logged warning when `OPENAI_API_KEY` or `PINECONE_API_KEY` missing. Fetch + extract scripts only need the network (no API keys). (Also requires `PINECONE_INDEX_NAME` to identify the target index; missing env vars are listed by name in the warning.)
- [x] Tests: parse a saved-fixture USPSTF HTML page (extractor); assert frontmatter shape on emitted chunk files; mock OpenAI + Pinecone clients in the reindex test; assert upsert called with expected per-chunk metadata; assert reindex no-ops cleanly without credentials. (8 vitest cases under `agent/tests/scripts/`, including selector-failure paths and BM25 sparse-vector shape assertions.)

**Definition of done.** `npm run corpus:fetch:uspstf && npm run corpus:extract:uspstf` populates `agent/data/corpus/uspstf/` with chunk files for every published USPSTF recommendation, all bodies verbatim from the publisher. `npm run evals:reindex-corpus` runs end-to-end against real Pinecone + OpenAI when credentials are present, populating namespace `guidelines-v1`. Re-running any step is idempotent. (Met: 300 chunks committed, fetch + extract idempotent on re-run, reindex no-ops cleanly without creds. End-to-end reindex against real vendors deferred until Pinecone index is provisioned by the user; tested via mocked clients and verified script structure.)

---

## C.3 `evidenceRetriever` — hybrid sparse-dense Pinecone retrieval + Cohere rerank

**Goal.** Replace the A.7 no-op stub with a real call over Pinecone hybrid index → Cohere rerank → top-`top_k` chunks returned. The supervisor's `args.query` and (optional) `args.source_filter` drive retrieval.

**Blocked by:** C.0, C.2.
**Unblocks:** C.5, C.7.

**Refs.** `W2_ARCHITECTURE.md` §"evidenceRetriever" (the layered retrieval table, Cohere rerank semantics); `WEEK2-PRESEARCH.md` §W2-7 (hybrid RAG design).

**Files touched.**
- `agent/src/graph/nodes/evidenceRetriever.ts` — replace stub.
- `agent/src/retrievers/pinecone.ts` (new) — hybrid retrieval client.
- `agent/src/retrievers/cohere.ts` (new) — rerank client.

**Checklist.**
- [x] Define args Zod schema:
  ```ts
  const EvidenceArgs = z.object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(10).default(3),
    source_filter: z.enum(['USPSTF', 'ADA', 'ACC-AHA', 'AGS-Beers', 'CDC']).array().optional(),
  });
  ```
  (Implemented as `EvidenceArgsSchema` in `agent/src/graph/types.ts`. `source_filter` lower bound is `min(1)` so an empty array can't slip past structured-output coercion. Closed enum `EVIDENCE_SOURCE_FILTERS` exported for reuse.)
- [x] **Pinecone hybrid retrieval** (`agent/src/retrievers/pinecone.ts`):
  - Embed `query` via OpenAI `text-embedding-3-large`.
  - Compute sparse BM25 vector via ~~`pinecone-text` SDK~~ shared `agent/src/retrievers/bm25.ts` (same Robertson formula the C.2 reindex script ships; `pinecone-text` is Python-only). BM25 stats are fitted from the indexed corpus chunks at agent boot so query-side and index-side weights line up.
  - Call Pinecone `query()` against the hybrid index with `topK: 20`, namespace from env (`PINECONE_NAMESPACE`, default `guidelines-v1`), optional metadata filter on `publication`.
  - Return raw chunk results with metadata projected to a `PineconeHybridHit` shape.
- [x] **Cohere rerank** (`agent/src/retrievers/cohere.ts`):
  - Take Pinecone top-20.
  - Call Cohere `rerank-v3.5` (Cohere renamed the `rerank-3` model id in 2025) over query + chunk texts via direct REST against `https://api.cohere.com/v2/rerank` (no SDK dep — one endpoint, ~30 lines of glue).
  - Return top-`top_k` with rerank scores.
  - **Degraded mode:** Cohere 5xx, network error, or timeout → client returns `null`; the C.3 node falls through to top-`k` by Pinecone hybrid score, tags each snippet with `degradedRerank: true`, and emits a `degraded-mode` trace event (per `W2_ARCHITECTURE.md` §"Failure Modes" "Cohere outage" row). 4xx responses (auth, malformed payload) throw — they're configuration bugs, not transient outages.
- [x] **Pinecone outage:** retriever throws `PineconeUnavailableError`; the C.3 node catches it and returns `{snippets: [], gap: {kind: 'gap', reason: 'evidence-retrieval-unavailable', message: …}}` so the supervisor sees the gap and routes around it (per `W2_ARCHITECTURE.md` §"Failure Modes" "Pinecone outage" row).
- [x] Implement the node `evidenceRetriever(state, args, deps)`:
  1. Resolve typed args from `state.evidenceRetrieverArgs` (the supervisor narrows them via `EvidenceArgsSchema` before routing — see C.3 prep commit).
  2. Pinecone hybrid retrieve → top-20.
  3. Cohere rerank → top-`top_k`.
  4. Project each hit to an `EvidenceSnippet` (`{chunkId, publication, year, section, title, url?, licenseTier, quote, rerankScore, degradedRerank}`). The full `SourceReference` projection (`source_type='guideline'`, `source_id=chunkId`, `locator.section`, substring-matched `quote`) lands in C.5's verifier path; the synthesizer reads the snippets and emits `SourceReference`s itself. Chunk text is excerpted to 600 chars to keep prompts bounded.
  5. Return `{evidenceRetrieverOutput: {snippets, gap: null}}` to the supervisor.
- [x] Per-call LangSmith trace metadata: `evidence_query_hash` (HMAC-SHA256-12 via shared `hashIdForTrace` + `tagSalt`), `evidence_source_filter`, `evidence_top_k`, `evidence_pinecone_count`, `evidence_pinecone_chunk_ids`, `evidence_returned_chunk_ids`, `evidence_returned_count`, `evidence_degraded_rerank`, `evidence_event` (one of `pinecone-outage` | `degraded-mode`), `latency_ms`. (Embedding/rerank dollar cost is *not* tracked at this layer — the supervisor's existing cost counters already track model-call cost; vendor-API cost is tallied centrally rather than per-node.)
- [x] Tests: stubbed-Pinecone + stubbed-Cohere unit tests for happy path, Cohere-degraded fallback, Pinecone outage gap, supervisor narrowing, source-filter forwarding, no-match empty signal, missing-args throw, out-of-bound rerank-index defense, 600-char excerpt. 9 vitest cases at `agent/tests/graph/nodes/evidenceRetriever.test.ts`; 7 for the Pinecone retriever; 6 for the Cohere client; 4 new supervisor-narrowing cases.

**Definition of done.** Real-Pinecone integration test (skipped without creds) issues a query like "USPSTF colorectal cancer screening" and gets a top-3 of relevant USPSTF chunks with rerank scores. (Met structurally: stubbed-vendor unit tests cover happy path + Cohere-degraded + Pinecone-outage + source-filter forwarding. End-to-end against real vendors deferred until the user provisions Pinecone + populates the index — same gate as C.2's reindex script.)

---

## C.4 Update supervisor manifest descriptions for the live retrievers

**Goal.** The supervisor's prompt-side handoff manifest (built in A.7) had brief stub descriptions; now that C.1 and C.3 are real, update the descriptions to match real behavior so the model picks well.

**Blocked by:** C.1, C.3.
**Unblocks:** C.7.

**Refs.** `W2_ARCHITECTURE.md` §"Supervisor loop" (handoff manifest, required rationale).

**Files touched.**
- `agent/src/graph/nodes/supervisor.ts` — handoff manifest descriptions.

**Checklist.**
- [ ] For `documentEvidenceRetriever`: update description to reflect real behavior — "Retrieves structured fact snippets (bbox + page + quote + field path) from previously extracted documents (lab PDFs, intake forms) for THIS patient. Use when the user's question references something on a recently uploaded document, or when chart-only context isn't enough to answer a question that documents might address. Args: `{query: string, doc_types?: ('lab_pdf'|'intake_form')[], lookback_days?: number, top_k?: number}`."
- [ ] For `evidenceRetriever`: "Retrieves clinical-guideline chunks from the curated guideline corpus (USPSTF for MVP). Use when the question would benefit from authoritative guideline reference — screening recommendations, treatment thresholds, prevention guidance. Args: `{query: string, top_k?: number, source_filter?: ('USPSTF')[]}`."
- [ ] For `kickoffExtraction`: confirm the description matches the B.9 wiring — "Triggers synchronous extraction of an unprocessed document already uploaded to this conversation. Args: `{document_uuid: string, doc_type: 'lab_pdf'|'intake_form'}`. Awaits the pipeline; appends the resulting artifact to state. Use only when envelope carries a `document_uuid` with no existing artifact."
- [ ] No tests-only — this is a prompt change. The behavior is exercised by C.7's eval cases.

**Definition of done.** The supervisor's manifest descriptions are accurate. Supervisor-routing eval cases in C.7 pass.

---

## C.5 Verifier: per-`source_type` resolution rules

**Goal.** The verifier (whose `chart` path was already migrated in A.8) gains the `extracted_document` and `guideline` resolution rules. Replaces the A.8 `NotYetImplementedError` throws. Confidence hard-stops are wired.

**Blocked by:** A.8, C.1, C.3.
**Unblocks:** C.6 (format groups by source_type), C.7.

**Refs.** `W2_ARCHITECTURE.md` §"Verifier resolution rules" (the three-row table), §"Hard stops on extraction confidence (Q14)" (combined-signal threshold logic).

**Files touched.**
- `agent/src/verify/verifier.ts` — extend the resolver dispatch.
- `agent/src/verify/confidenceThresholds.ts` (new) — pinned 0.7 threshold.

**Checklist.**
- [ ] Define `agent/src/verify/confidenceThresholds.ts` with:
  ```ts
  export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.7;
  export const ALLERGY_CONFIDENCE_THRESHOLD = 0.7;  // category-level fail-closed
  export function isLowConfidence(signal: ConfidenceSignal): boolean { /* combined */ }
  ```
  Combined signal per architecture: self-reported vision confidence + zero schema warnings + full patient-match. Any one failing → low confidence.
- [ ] Extend the verifier's resolver:
  - **`extracted_document`:** `source_id` must be in this turn's `state.extractionArtifacts`; `locator.page` and `locator.bbox` must equal the recorded extraction's bbox/page (no fabricated bboxes); `quote` substring-matches the extracted value at `locator.field`. Reject otherwise.
  - **`guideline`:** `source_id` must be in this turn's `state.evidenceRetrieverOutputs` (track these as a state slot if not already); `quote` substring-matches the chunk text at `locator.section`. Reject otherwise.
- [ ] Confidence hard-stops — applied AFTER source-reference resolution, BEFORE fact-level rejection:
  - Default: fact-level rejection. Low-confidence claim is dropped from the response with reason `low-confidence-extraction`. UI shows a Gap chip on the affected fact (renderer is F's responsibility, but the rejection reason is set here).
  - Allergy exception: category-level fail-closed. Low-confidence allergy fact in an intake form fails the entire medication section closed (per `W2_ARCHITECTURE.md` §"Hard stops on extraction confidence" allergy exception). User sees "Medication summary withheld — allergy data unverified."
- [ ] Tests: per-`source_type` accept/reject; fabricated-bbox extracted-document claim rejected; chunk-not-in-retriever-output guideline claim rejected; low-confidence allergy → category fail-closed.

**Definition of done.** A claim citing a fabricated bbox is rejected. A claim citing a non-existent guideline chunk is rejected. Low-confidence allergy on intake fails the category closed.

---

## C.6 Format node: group claims by `source_type` for the panel UI

**Goal.** The format node walks the verified ledger and groups claims into three sections so the UI can render them: "What's in the chart" (chart), "From documents" (extracted_document), "Evidence" (guideline). The W1 sectioning inside "What's in the chart" carries forward unchanged.

**Blocked by:** C.5.
**Unblocks:** D.0 (panel UI rendering), F (Tier-3 promotion controls live in the "From documents" section).

**Refs.** `W2_ARCHITECTURE.md` §"Format" (the three-section grouping); existing format node at `agent/src/graph/nodes/format.ts`.

**Files touched.**
- `agent/src/graph/nodes/format.ts`.

**Checklist.**
- [ ] Update format to group by `source_type`:
  - Walk verified ledger → bucket each claim by `claim.sourceReferences[0].source_type`.
  - "What's in the chart" — W1 sub-sections preserved (appointment context, demographics, deltas, diagnoses, meds, labs, allergies, encounters).
  - "From documents" — flat list of facts grouped by document (one document = one sub-card with facts under it).
  - "Evidence" — flat list of guideline citations with publication + year + section.
- [ ] If a claim has multiple source references with mixed `source_type`, place it in the section of its **primary** source reference (first in the array). Document this in a comment.
- [ ] Tests: assert grouping; assert empty section is omitted from output; assert mixed-source claim placement.

**Definition of done.** A test fixture with all three source types verified produces an output with three sections in the expected order. An empty "Evidence" section is omitted (not rendered as empty header).

---

## C.7 Conversational-graph eval cases — 12 cases land in CI

**Goal.** Phase C's 12 eval cases (per `W2_IMPLEMENTATION_PHASES.md` Phase C "Eval cases that land") pass real-model in CI. Cases cover the new retrievers, the verification extension, and the supervisor-routing extension.

**Blocked by:** C.5, C.6.
**Unblocks:** Phase D end-to-end.

**Refs.** `W2_IMPLEMENTATION_PHASES.md` Phase C eval cases; `W2_ARCHITECTURE.md` §"Eval Architecture" (boolean rubrics, plausibility-based supervisor-routing).

**Files touched.**
- `agent/evals/cases/conversational-graph/{document-evidence,guidelines,verification,supervisor-routing-extensions}/*.test.ts` (new).
- `agent/evals/runners/documentExtractionSuite.ts` (extend) — case manifests for the new groups.

**Checklist.**
- [ ] **Document-evidence retriever (4 cases):** per-patient retrieval with known artifact set + known query → top-k matches with bbox/page/quote preserved through the verifier. Pid scope cannot be widened (a patient B query against patient A's session returns nothing). Stale `lookback_days` excludes old artifacts. Empty-state (no artifacts) returns gracefully.
- [ ] **Guidelines retriever / RAG (4 cases):** hybrid sparse+dense+rerank. Relevant query (e.g., "USPSTF colorectal cancer screening") returns expected chunk in top-1. Out-of-scope query returns no spurious hits. Cohere outage falls through to Pinecone hybrid score (degraded-mode trace event emitted). Pinecone outage produces a gap (graceful "skip with warning").
- [ ] **Verification (4 cases):** per-`source_type` rules. Chart claim accept/reject (W1 carry-forward, just renamed). Extracted-document claim with fabricated bbox rejected. Guideline claim citing chunk not in retriever output rejected. Low-confidence allergy in intake → allergy-category fail-closed asserted.
- [ ] (Supervisor-routing extensions — 6 cases — were already counted in Phase A's 6 supervisor-routing cases in the eval distribution table per `W2_ARCHITECTURE.md` §"Case distribution". This phase's 4 verification + 4 docevidence + 4 guideline = 12; the supervisor-routing cases in A's set get extended assertions for the new handoffs but don't double-count.)
- [ ] All cases use real Anthropic Sonnet 4.x for synthesis, real OpenAI embeddings, real Cohere rerank, real Pinecone in CI per architecture §"Real model in CI for all 50 cases".
- [ ] Run `npm test`; run `npm run evals:experiment` against real model when credentials present.

**Definition of done.** 12 cases green. Supervisor's decisions in LangSmith for each run show a model-picked `query` and (when applicable) `doc_types`/`source_filter`. Real-model rubric pass-rate ≥95% per category.
