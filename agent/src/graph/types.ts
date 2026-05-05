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
import type { SuggestedFollowUp, SuggestedFollowUpParams } from './followUps.js';

export type { SuggestedFollowUp, SuggestedFollowUpParams };

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
                record_recorded_at: z.string().min(1).optional(),
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
     * §4.5 free-text follow-up: the clinician's typed question. Present
     * only when `task === 'follow_up'` and the suggestions rail did not
     * pre-fill a typed parameter set. The synthesizer routes a follow-up
     * with `question` through the generic "answer cited question" path;
     * the verifier still gates every emitted claim against the snapshot,
     * so the source-citation guarantee holds whether the question came
     * from a typed suggestion or free text.
     */
    readonly question?: string;
    /**
     * §4.1 typed suggested-follow-up parameter set. Mutually exclusive
     * with `question` at the schema layer — the boundary parses one or
     * the other into the envelope, never both. The §4.1 server bridges
     * a typed `followUp` into a deterministic `question` so the existing
     * free-text path runs end-to-end; §4.2/§4.3/§4.4 will replace that
     * bridge with UC-specific graph branches.
     */
    readonly followUp?: SuggestedFollowUpParams;
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
 * UC2 lab-history slot. Only populated when the envelope carries
 * `followUp.type === 'lab_trend'` — `Retrieve` fans out an extra
 * `getLabHistory` call for the suggested-follow-up's analyte and
 * files the result here. `null` is the default ("this turn does not
 * need history") and is what every non-UC2 turn carries; a `Gap`
 * means the history endpoint failed-open and the synthesizer should
 * say so explicitly rather than render an empty trend.
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

export interface AssistantMessage {
    readonly segments: readonly AssistantMessageSegment[];
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
