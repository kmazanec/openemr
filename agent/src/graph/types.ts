import { z } from 'zod';

import type {
    Allergy,
    Appointment,
    Demographics,
    Diagnosis,
    Encounter,
    LabObservation,
    MedicationStatement,
    Prescription,
    Reminder,
    SourceReference,
} from '../snapshot/types.js';
import type { SuggestedFollowUp } from './followUps.js';

export type { SuggestedFollowUp };

/**
 * Unified W2 `SourceReference` shape — the single citation contract
 * shared between the agent and OpenEMR. Mirrors
 * `W2_ARCHITECTURE.md` §"Unified `SourceReference` shape": every fact
 * the synthesizer cites carries one of these, discriminated by
 * `source_type`, with locator polymorphism enforced at parse time so
 * bad combinations never reach the verifier.
 *
 * The locator polymorphism rule (`extracted_document` requires
 * `page` AND `bbox`; `guideline` requires `section`; `chart`
 * requires `field`) is the architecture's hedge against fabricated
 * citations: a chart claim without a `field`, or a document claim
 * without a `bbox`, would be an unresolvable citation, and the
 * verifier would have to reject it at run time. Rejecting it at
 * parse time fails the synthesizer earlier and louder.
 *
 * The PHP-side `SourceReference` value object at
 * `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/SourceReference.php`
 * mirrors this exact shape and validates the same polymorphism. The
 * cross-language contract is pinned by
 * `agent/tests/graph/sourceReferenceContract.test.ts` against a
 * fixture produced by the PHP-side
 * `SourceReferenceContractTest`.
 */
export const SourceReferenceSchema = z
    .object({
        source_type: z.enum(['chart', 'extracted_document', 'guideline']),
        source_id: z.string().min(1),
        locator: z.object({
            page: z.number().int().nonnegative().optional(),
            bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
            section: z.string().min(1).optional(),
            field: z.string().min(1).optional(),
        }),
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
        meta: z
            .object({
                document_uuid: z.string().min(1).optional(),
                extractor_version: z.string().min(1).optional(),
                rerank_score: z.number().optional(),
                record_recorded_at: z
                    .union([z.literal(''), z.string().min(1)])
                    .optional()
                    .transform((v) => (v === '' ? undefined : v)),
            })
            .optional(),
    })
    .superRefine((value, ctx) => {
        switch (value.source_type) {
            case 'extracted_document':
                if (value.locator.page === undefined) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['locator', 'page'],
                        message: "extracted_document SourceReference requires locator.page",
                    });
                }
                if (value.locator.bbox === undefined) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['locator', 'bbox'],
                        message: "extracted_document SourceReference requires locator.bbox",
                    });
                }
                break;
            case 'guideline':
                if (value.locator.section === undefined) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['locator', 'section'],
                        message: "guideline SourceReference requires locator.section",
                    });
                }
                break;
            case 'chart':
                if (value.locator.field === undefined) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['locator', 'field'],
                        message: "chart SourceReference requires locator.field",
                    });
                }
                break;
        }
    });

/**
 * Inferred TS type from the unified W2 schema. Distinct from the
 * legacy `SourceReference` interface re-exported from
 * `../snapshot/types.js` — that name still refers to the W1
 * `{system, recordType, recordId, field, recordedAt}` shape until
 * sub-phase A.2 migrates every call site. Until then the two live
 * side by side: the W1 interface is the producer-side shape, the
 * W2 schema is the cross-language contract.
 */
export type SourceReferenceUnified = z.infer<typeof SourceReferenceSchema>;

/**
 * §A.5 prior-turn dialog memory. Mirrors `W2_ARCHITECTURE.md`
 * §"Prior-turn context" — the supervisor and synthesizer read a
 * runner-prepared `priorTurnContext: PriorTurnContext` slot whose
 * `turns` carry the last K=5 turn pairs (user verbatim, assistant
 * `{citations, facts}`).
 *
 * The asymmetric shape is intentional: user text is the only signal
 * of dialog thread that can't be recovered from data, so it replays
 * verbatim; assistant turns replay as resolved citations + raw values
 * because prose is a derived rendering and threading it would pollute
 * the structured-output channel.
 *
 * Plain TS interfaces (rather than Zod-inferred shapes) because this
 * value is materialized server-side rather than parsed at a wire
 * boundary; the citation type reused here is the same
 * `SourceReference` from `../snapshot/types.js` that every other
 * snapshot-touching surface speaks.
 */
export interface PriorTurnAssistantFact {
    readonly sourceRef: SourceReference;
    /**
     * Mirrors the snapshot slot the citation came from. Typing it
     * as a slot-by-slot discriminated union would couple the
     * prior-turn schema to every adapter shape — the verifier
     * already owns slot resolution. Carry the resolved slice
     * opaquely; the supervisor reads `sourceRef.source_type` for
     * routing without needing to look at the value, and the
     * synthesizer treats it as already-trusted chart data. Opaque-
     * pointer fallback is encoded as `rawValue: null`.
     */
    readonly rawValue: unknown;
}

export type PriorTurn =
    | { readonly role: 'user'; readonly text: string }
    | {
        readonly role: 'assistant';
        readonly citations: readonly SourceReference[];
        readonly facts: readonly PriorTurnAssistantFact[];
    };

export interface PriorTurnContext {
    readonly turns: readonly PriorTurn[];
}

/**
 * Reference to a document the panel just attached and is waiting on the
 * supervisor to do something with. The agent boundary parses one of
 * these per upload; the supervisor decides on its first iteration
 * whether to fire `kickoffExtraction` for each pending entry, retrieve
 * complementary chart context, query the guideline knowledge base, etc.
 *
 * Carrying the list as data on the envelope (rather than firing the
 * pipeline before the conversational graph runs) keeps the supervisor
 * in charge: it can decide _whether_ to extract, _what_ to do with the
 * extracted facts, and _how_ to frame the result back to the clinician.
 */
export interface PendingUpload {
    readonly documentUuid: string;
    readonly docType: 'lab_pdf' | 'intake_form';
    /**
     * File extension of the canonical Spaces object the upload landed
     * at — `pdf`, `png`, `jpg`, `jpeg`, `tiff`. The pipeline's rasterize
     * node uses it to compose the canonical key (`<pid>/<uuid>.<ext>`)
     * and to decide whether to PDF-render or pass the image through as
     * a single page. The panel returns this from `document_upload.php`.
     */
    readonly canonicalExt: string;
}

/**
 * Request envelope OpenEMR sends to the agent. Mirrors ARCHITECTURE.md
 * §"Request Envelope" — actor identity, patient context, conversation
 * scope, and the task the agent is asked to perform. The agent uses
 * this envelope to drive `Retrieve` (which patient, with which token)
 * and to gate every downstream node against the same identity.
 */
export interface RequestEnvelope {
    readonly conversationId: string;
    readonly requestId: string;
    readonly siteId: string;
    readonly actor: { readonly userId: string; readonly fhirUser: string };
    readonly patient: { readonly pid: number; readonly uuid: string };
    readonly task: 'default_briefing' | 'follow_up';
    /**
     * Free-text follow-up: the clinician's typed question. Present only
     * when `task === 'follow_up'`. Both typed-into-the-composer questions
     * and tapped suggestion chips arrive here as plain text — the panel
     * sends a chip's `displayText` as `question` so the supervisor sees
     * one shape regardless of how the user expressed the follow-up.
     */
    readonly question?: string;
    /**
     * Documents the user just attached this turn that the supervisor
     * has not yet processed. The agent's first supervisor iteration
     * sees this list and chooses whether to kick off extraction for
     * each entry. Allowed on either task — a clinician might attach a
     * doc to the very first turn of a fresh conversation
     * (`default_briefing`) or in the middle of an ongoing conversation
     * (`follow_up`).
     */
    readonly pendingUploads?: readonly PendingUpload[];
}

/**
 * §A.4 closed enumeration of categories the supervisor may request when
 * picking the `retrieveChart` handoff after the first iteration. Mirrors
 * `W2_ARCHITECTURE.md` §"retrieveChart" verbatim. The supervisor-facing
 * vocabulary uses `'medication'` (plain English for the model); the
 * snapshot-endpoint client speaks `'prescription'`. The retriever node
 * is the only place that bridges the two.
 */
export const RETRIEVE_CHART_CATEGORIES = [
    'diagnosis',
    'medication',
    'allergy',
    'lab',
    'encounter',
    'reminder',
    'medication_statement',
    'appointment',
] as const;
export type RetrieveChartCategory = typeof RETRIEVE_CHART_CATEGORIES[number];

/**
 * §A.4 supervisor handoff args for `retrieveChart`. Set on
 * `BriefingState.retrieveChartArgs` by the A.7 supervisor before each
 * iteration after the first; `null` means "first call, run the full
 * deterministic fan-out". Empty `categories` is invalid and rejected at
 * the node entry — the architecture's structured-output schema will
 * enforce the same upstream once A.7 lands.
 */
export interface RetrieveChartArgs {
    readonly categories: readonly RetrieveChartCategory[];
}

/**
 * §C.1 supervisor handoff args for `documentEvidenceRetriever`. The
 * model picks a query plus optional doc-type / lookback / top-k filters;
 * the patient scope (`pid`) is non-negotiable and comes from the
 * envelope, not the args. The Zod schema below is the authoritative
 * shape — `DocumentEvidenceArgs` is the inferred TS type.
 *
 * Bounded ranges defend against degenerate queries: `lookback_days`
 * caps at 10 years (3650) so the model can't ask for the entire chart
 * history in one call; `top_k` caps at 20 to keep the supervisor's next
 * iteration's prompt body bounded.
 *
 * Defaults match the architecture (`W2_ARCHITECTURE.md` §"documentEvidenceRetriever"):
 * 90-day lookback, top-5 results. Either the supervisor sets explicit
 * values (per its prompt steering) or the defaults bind.
 */
export const DocumentEvidenceArgsSchema = z.object({
    query: z.string().min(1),
    doc_types: z.array(z.enum(['lab_pdf', 'intake_form'])).min(1).optional(),
    lookback_days: z.number().int().min(1).max(3650).default(90),
    top_k: z.number().int().min(1).max(20).default(5),
});

export type DocumentEvidenceArgs = z.infer<typeof DocumentEvidenceArgsSchema>;

/**
 * §C.3 closed enumeration of guideline publishers the supervisor may
 * filter on. MVP ships USPSTF only; the architecture (§"evidenceRetriever")
 * pre-declares the full set so adding a new publisher in a later phase is
 * a corpus-ingest change, not a schema change.
 */
export const EVIDENCE_SOURCE_FILTERS = [
    'USPSTF',
    'ADA',
    'ACC-AHA',
    'AGS-Beers',
    'CDC',
] as const;
export type EvidenceSourceFilter = typeof EVIDENCE_SOURCE_FILTERS[number];

/**
 * §C.3 supervisor handoff args for `evidenceRetriever`. The model picks
 * a `query` plus optional `top_k` and `source_filter`; defaults bind to
 * the values pinned in `W2_ARCHITECTURE.md` §"evidenceRetriever" (top-3
 * after rerank).
 *
 * Bounded ranges defend against degenerate queries: `top_k` caps at 10
 * to keep the rerank window bounded and the synthesizer's prompt body
 * small. `source_filter`, when set, restricts retrieval to the named
 * publishers via Pinecone metadata filter — empty arrays are rejected so
 * "filter to nothing" can't slip past structured-output coercion.
 */
export const EvidenceArgsSchema = z.object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(10).default(3),
    source_filter: z.array(z.enum(EVIDENCE_SOURCE_FILTERS)).min(1).optional(),
});

export type EvidenceArgs = z.infer<typeof EvidenceArgsSchema>;

/**
 * §C.3 single retriever-output snippet: one Pinecone hybrid hit, after
 * Cohere rerank, projected onto a citable `SourceReference` shape with
 * `source_type='guideline'`. Mirrors the architecture's
 * `EvidenceSnippet` shape (`W2_ARCHITECTURE.md` §"evidenceRetriever").
 *
 * `chunkId` is the stable `<source>::<basename>` id the reindex script
 * upserts to Pinecone (see `agent/scripts/reindex-corpus.ts`); the
 * synthesizer cites it as `SourceReference.source_id` and the C.5
 * verifier resolves the citation by matching `chunkId` against this
 * turn's retriever outputs. `quote` is the chunk body (or its leading
 * window) — the synthesizer's quote must substring-match it.
 * `rerankScore` is the Cohere `rerank-v3.5` relevance score in `[0, 1]`; on
 * Cohere outage it's the Pinecone hybrid score (degraded mode).
 */
export interface EvidenceSnippet {
    readonly chunkId: string;
    readonly publication: string;
    readonly year: number;
    readonly section: string;
    readonly title: string;
    readonly url?: string;
    readonly licenseTier: string;
    readonly quote: string;
    readonly rerankScore: number;
    /**
     * True when Cohere's rerank service was unreachable and the order
     * fell through to Pinecone hybrid score. Surfaced in trace metadata
     * so degraded-mode runs are observable; the synthesizer treats the
     * snippet identically. Per `W2_ARCHITECTURE.md` §"Failure Modes" —
     * "Cohere outage" row.
     */
    readonly degradedRerank: boolean;
}

/**
 * §C.3 retriever output. Either a list of snippets (possibly empty if
 * the query matched nothing) or a {@link Gap} when Pinecone is
 * unreachable. The supervisor reads the gap to route around the failure
 * — per `W2_ARCHITECTURE.md` §"Failure Modes" "Pinecone outage" row.
 */
export interface EvidenceRetrieverOutput {
    readonly snippets: readonly EvidenceSnippet[];
    readonly gap: Gap | null;
}

/**
 * §C.1 single retriever-output snippet: one extracted fact projected
 * onto a citable `SourceReference` shape. Mirrors the architecture's
 * `ExtractedFactSnippet` shape (`W2_ARCHITECTURE.md` §"documentEvidenceRetriever").
 *
 * `fieldPath` is the dotted path within the artifact's `schemaJson`
 * (e.g. `results.0.value` for the first lab result's value); it doubles
 * as `SourceReference.locator.field` when the synthesizer cites the
 * snippet. `bbox`/`page` are the OCR coordinates of the supporting text
 * — verifier (C.5) compares the synthesizer's bbox against the recorded
 * one, so fabricated bboxes can't slip through. `quote` is the original
 * OCR text under that bbox.
 */
export interface ExtractedFactSnippet {
    readonly artifactId: string;
    readonly documentUuid: string;
    readonly docType: 'lab_pdf' | 'intake_form';
    readonly fieldPath: string;
    readonly value: unknown;
    readonly page: number;
    readonly bbox: readonly [number, number, number, number];
    readonly quote: string;
    readonly confidence?: number;
    readonly extractorVersion: string;
    /** ISO-8601 timestamp from the artifact's `created_at`. Used for recency ranking. */
    readonly createdAt: string;
}

/**
 * Closed enumeration of handoffs the supervisor may pick. The Zod schema
 * below binds the model to this set — picking a value outside the enum
 * fails structured-output coercion, not just a runtime check. Order is
 * informational; the supervisor reads its own decision history this turn
 * to detect cycles.
 */
export const SUPERVISOR_HANDOFFS = [
    'kickoffExtraction',
    'retrieveChart',
    'documentEvidenceRetriever',
    'evidenceRetriever',
    'synthesize',
] as const;
export type SupervisorHandoff = typeof SUPERVISOR_HANDOFFS[number];

/**
 * §A.7 supervisor structured-output schema. Output is Zod-coerced to
 * `{handoff, reason, args?}`:
 *  - `handoff`: a value from the closed enum; the model cannot invent
 *    one.
 *  - `reason`: non-empty by Zod contract — required rationale per
 *    `W2_ARCHITECTURE.md` §"Decision rationale is required".
 *  - `args`: optional structured arguments for the chosen handoff.
 *    Loosely typed at this layer (`Record<string, unknown>`) because
 *    each handoff defines its own arg shape (e.g. `RetrieveChartArgs`,
 *    `documentEvidenceRetriever`'s `query` etc.); per-handoff narrowing
 *    happens inside the supervisor before the args reach the matching
 *    state slot.
 *
 * Malformed model output (missing `handoff`, empty `reason`, value
 * outside the enum) is rejected by `withStructuredOutput` before it
 * reaches graph state — the runner surfaces a typed error rather than
 * letting the graph route on garbage.
 */
export const SupervisorDecisionSchema = z.object({
    handoff: z.enum(SUPERVISOR_HANDOFFS),
    reason: z.string().min(1),
    /**
     * One short clinician-facing sentence (≤120 chars) describing what
     * the supervisor is about to do, written for the doctor watching
     * the panel — e.g. "Pulling prior lipid panels to compare." or
     * "Checking the USPSTF on statin primary prevention." The runner
     * forwards this verbatim as a `supervisorNarration` SSE event so
     * the panel's progress line reflects the agent's current intent
     * rather than a fixed stage label. Required: every routing
     * decision deserves a sentence the clinician would understand.
     */
    narration: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).optional(),
});

export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;

/**
 * Snapshot built up by `Retrieve`. Each tool's output is filed into the
 * matching slot. Fail-open tools (`labs`, `encounters`) carry an
 * explicit gap when the data layer hiccups so `Format` can render the
 * gap rather than silently omit the section.
 */
export interface Gap {
    readonly kind: 'gap';
    readonly reason: string;
    readonly message: string;
}

/**
 * Lab-history slot. Reserved for a future supervisor-invoked
 * lab-history fetch — the slot survives the deterministic-branch
 * removal so the verifier can still resolve trend citations against
 * a populated series, and so the seed pipeline keeps a place to
 * land analyte-scoped history when it becomes useful again. `null`
 * is the default ("this turn does not need history"); a `Gap` means
 * a future fetcher failed-open and the synthesizer should say so
 * explicitly rather than render an empty trend.
 */
export interface LabHistorySeries {
    readonly analyte: string;
    readonly observations: readonly LabObservation[];
}

export interface BriefingSnapshot {
    readonly patient: Demographics;
    readonly appointment: Appointment | null;
    readonly diagnoses: readonly Diagnosis[];
    readonly prescriptions: readonly Prescription[];
    readonly allergies: readonly Allergy[];
    readonly labs: readonly LabObservation[] | Gap;
    readonly encounters: readonly Encounter[] | Gap;
    readonly labHistory: LabHistorySeries | Gap | null;
    /**
     * §4.6.3: clinical reminders. Informational fail-open — accepts a
     * `Gap` because a reminders-fetch failure should render a banner,
     * not fail the whole turn (unlike `prescriptions`/`allergies`
     * which are safety-critical). The verifier rule still requires a
     * resolved row to back any `reminder` claim.
     */
    readonly reminders: readonly Reminder[] | Gap;
    /**
     * §4.6.4: patient-reported medications (FHIR
     * `MedicationStatement`). Independent data source from
     * `prescriptions` — patient-reported entries stay visible even
     * when the prescription hard-stop fires (a clinician seeing
     * "patient says they're taking Tylenol" is more useful than a
     * silent drop when the Rx list is unavailable). Same Gap-tolerant
     * shape as `reminders`.
     */
    readonly medications: readonly MedicationStatement[] | Gap;
}

/**
 * Single factual claim emitted by `Synthesize`. ARCHITECTURE.md
 * §"Claim Ledger" pins the fields. `Verify` (Phase 3.3) consumes this
 * shape; we ship it now so `Synthesize` has a stable target schema.
 */
export type ClaimCategory =
    | 'prescription'
    | 'prescription_change'
    | 'lab'
    | 'allergy'
    | 'diagnosis'
    | 'encounter'
    | 'appointment'
    | 'identity'
    | 'reminder'
    | 'medication_statement';

export interface Claim {
    readonly id: string;
    readonly text: string;
    readonly category: ClaimCategory;
    readonly sourceReferences: readonly SourceReference[];
    readonly safetyCritical: boolean;
}

export interface ClaimLedger {
    readonly claims: readonly Claim[];
}

export interface VerifiedLedger {
    readonly passed: boolean;
    readonly accepted: readonly Claim[];
    readonly rejected: readonly { readonly claim: Claim; readonly reason: string }[];
    readonly safetyHardStops: readonly string[];
}

/**
 * Synthesizer output before `Format` resolves claim ids. Each segment is
 * one prose run the model wants to say about the patient, plus the ledger
 * ids of the claims that back it. Connector segments (transitions, signposts)
 * carry an empty `claimIds` so the schema does not encourage the model to
 * invent citations for grammatical glue.
 */
export interface DraftSegment {
    readonly text: string;
    readonly claimIds: readonly string[];
}

export interface DraftBriefing {
    readonly segments: readonly DraftSegment[];
}

/**
 * Final clinician-facing payload `Format` produces — a single ordered list
 * of prose segments with their backing claims attached, plus message-level
 * gaps for safety hard stops. The §3.4 UI renders this as a chat bubble:
 * each segment becomes an inline run with `[source]` chips, redacted
 * segments render as "[content withheld]", and gaps surface as warning
 * banners at the top of the bubble.
 *
 * Replaces the seven-section `FormattedBriefing` shape used through §3.3.
 * The verifier-driven fail-closed semantics (allergies-unavailable →
 * suppress prescription content) carry over: matching segments are redacted
 * before they leave `Format`.
 */
export interface AssistantMessageSegment {
    readonly text: string;
    /**
     * Claims (post-verifier) that back the segment text. Empty for
     * connector segments and for redacted segments.
     */
    readonly claims: readonly Claim[];
    /**
     * True when at least one claim id named by the synthesizer was
     * rejected by the verifier or missing from the ledger, OR the segment
     * was suppressed by a safety hard stop. The renderer never asserts
     * the original text in either case.
     */
    readonly redacted: boolean;
}

/**
 * §C.6 chart sub-section: one W1 category-bucket inside the panel UI's
 * "What's in the chart" section. The synthesizer's claims arrive flat;
 * the format node groups them by `Claim.category` so the renderer keeps
 * the W1 sub-card structure (diagnoses, meds, labs, …) without
 * re-walking the snapshot.
 */
export interface ChartGroupSubsection {
    readonly category: ClaimCategory;
    readonly claims: readonly Claim[];
}

export interface ChartClaimGroup {
    readonly subsections: readonly ChartGroupSubsection[];
}

/**
 * §C.6 extracted-document card: one source document, one card. Multiple
 * claims citing the same `meta.document_uuid` collapse into a single
 * card so the panel UI renders one sub-card per uploaded document with
 * its facts listed under it. `documentUuid: null` is the "primary
 * extracted_document ref carried no document_uuid" path — the verifier
 * resolves on bbox/page/source_id, so a missing meta is allowable; the
 * panel groups all such claims under a single null-keyed card.
 */
export interface DocumentClaimCard {
    readonly documentUuid: string | null;
    readonly claims: readonly Claim[];
}

export interface DocumentClaimGroup {
    readonly cards: readonly DocumentClaimCard[];
}

export interface GuidelineClaimGroup {
    readonly claims: readonly Claim[];
}

/**
 * §C.6 panel-side projection of accepted claims, bucketed by primary
 * `SourceReference.source_type`. Empty buckets are absent (Partial
 * keys) so the renderer omits the section header naturally —
 * `f.claimGroups.guideline === undefined` reads as "no Evidence section
 * this turn".
 *
 * The chat bubble (`segments[]`) is unchanged: prose flow stays
 * chronological. `claimGroups` is an additive projection over the same
 * accepted claims for the side panel.
 */
export interface ClaimGroups {
    readonly chart?: ChartClaimGroup;
    readonly extractedDocument?: DocumentClaimGroup;
    readonly guideline?: GuidelineClaimGroup;
}

export interface AssistantMessage {
    readonly segments: readonly AssistantMessageSegment[];
    /**
     * §C.6 panel-UI projection of accepted claims grouped by
     * `claim.sourceReferences[0].source_type`. Empty sections are
     * omitted. Hard-stop-suppressed claims are filtered out before
     * grouping so the panel stays in sync with the bubble's redactions.
     */
    readonly claimGroups: ClaimGroups;
    /**
     * Safety hard stops surfaced once at message level rather than per
     * section. UI renders as a yellow-bar warning at the top of the
     * assistant bubble.
     */
    readonly gaps: readonly Gap[];
    /**
     * §4.1 suggested follow-ups. Always present, possibly empty. Each
     * suggestion is grounded in claims that actually appeared in the
     * verified ledger — there are no generic "Recap the chart" filler
     * suggestions. The renderer shows these as tap-to-run chips below
     * the assistant bubble; clicking a chip POSTs the typed `followUp`
     * params back through the briefing endpoint.
     */
    readonly suggestedFollowUps: readonly SuggestedFollowUp[];
    /**
     * §5.5 archetype-derived chips that the §5.4 schedule view rolls
     * into the row's `flags[]`. Pure function over the snapshot — see
     * `graph/archetypeFlags.ts`. Empty for snapshots whose data does
     * not match any archetype rule. Distinct from `gaps[]` (verifier
     * issues) and from `suggestedFollowUps` (UI chips).
     */
    readonly archetypeFlags: readonly string[];
}

export interface PersistedRecord {
    readonly conversationId: string;
    readonly requestId: string;
    readonly persistedAt: string;
}

/**
 * §B.9 closed enumeration of pipeline error codes the kickoffExtraction
 * node may surface back to the supervisor. Mirrors `PipelineErrorCode`
 * in `agent/src/pipeline/state.ts`; duplicated here so the conversational
 * graph's typings don't reach across into the pipeline package's
 * internals. The two lists must stay in sync — see
 * `agent/tests/graph/nodes/kickoffExtraction.test.ts` for the contract
 * pin.
 */
export const KICKOFF_EXTRACTION_ERROR_CODES = [
    'cost-cap-exceeded',
    'rasterize_failed',
    'storage-unreachable',
    'rate-limited',
    'schema_invalid',
    'patient_mismatch',
    'persist_failed',
    'invalid_args',
    'pipeline_runtime_error',
    'pipeline_no_terminal_state',
] as const;
export type KickoffExtractionErrorCode = typeof KICKOFF_EXTRACTION_ERROR_CODES[number];

/**
 * §B.9 supervisor handoff args for `kickoffExtraction`. The supervisor
 * picks an unprocessed `document_uuid` already attached to this
 * conversation plus the doc type the panel uploaded; the patient pid
 * is non-negotiable and comes from the envelope, not the args (same
 * pattern as `documentEvidenceRetriever`'s `pid` scope rule).
 *
 * `document_uuid` width matches the §B.8 extract route's bound so the
 * two surfaces accept the same identifiers — the canonical UUIDs are
 * 36-char strings but extra width is harmless and a strict 36 would
 * reject any future format migration. `lab_pdf` and `intake_form` are
 * the only doc types the strict pipeline schemas support today (§B.4);
 * adding a new doc type is a paired schema + enum change.
 */
export const KickoffExtractionArgsSchema = z.object({
    document_uuid: z.string().min(1).max(200),
    doc_type: z.union([z.literal('lab_pdf'), z.literal('intake_form')]),
});

export type KickoffExtractionArgs = z.infer<typeof KickoffExtractionArgsSchema>;

/**
 * §B.9 summary projection the kickoffExtraction node appends to
 * `state.kickoffExtractionResults` after each pipeline run. The full
 * `ExtractionArtifact` row lives in agent Postgres and the C.1
 * `documentEvidenceRetriever` reads it from there; the supervisor's
 * downstream iterations only need to know that *an* artifact landed for
 * a given `(document_uuid, doc_type)` and what its terminal status was,
 * so the supervisor can route around a `failed` artifact (per
 * `W2_ARCHITECTURE.md` §"Failure isolation") without re-fetching the
 * row.
 *
 * `artifactId` is null on the failed path before the persist node ran
 * (cost-cap, schema-invalid, patient-mismatch, rasterize failure); it
 * is set on the failed path only when the persist node itself failed
 * after writing a `failed`-status artifact (today the pipeline does
 * not write a row on persist failure — `artifactId` will read as null
 * in that case too, but the type leaves room for it).
 */
export interface KickoffExtractionResult {
    readonly documentUuid: string;
    readonly docType: 'lab_pdf' | 'intake_form';
    readonly status: 'persisted' | 'failed';
    readonly artifactId: string | null;
    /**
     * Pipeline error code on the failed path; null when the pipeline
     * persisted successfully. Mirrors the pipeline's `PipelineErrorCode`
     * union.
     */
    readonly errorCode: KickoffExtractionErrorCode | null;
}
