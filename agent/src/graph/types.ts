import type {
    Allergy,
    Appointment,
    Demographics,
    Diagnosis,
    Encounter,
    LabObservation,
    Medication,
    SourceReference,
} from '../snapshot/types.js';

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

export interface BriefingSnapshot {
    readonly patient: Demographics;
    readonly appointment: Appointment | null;
    readonly diagnoses: readonly Diagnosis[];
    readonly medications: readonly Medication[];
    readonly allergies: readonly Allergy[];
    readonly labs: readonly LabObservation[] | Gap;
    readonly encounters: readonly Encounter[] | Gap;
}

/**
 * Single factual claim emitted by `Synthesize`. ARCHITECTURE.md
 * §"Claim Ledger" pins the fields. `Verify` (Phase 3.3) consumes this
 * shape; we ship it now so `Synthesize` has a stable target schema.
 */
export type ClaimCategory =
    | 'medication'
    | 'lab'
    | 'allergy'
    | 'diagnosis'
    | 'encounter'
    | 'appointment'
    | 'identity';

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
 * suppress medication content) carry over: matching segments are redacted
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
}

export interface PersistedRecord {
    readonly conversationId: string;
    readonly requestId: string;
    readonly persistedAt: string;
}
