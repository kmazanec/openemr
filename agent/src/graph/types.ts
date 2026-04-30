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
 * Final clinician-facing payload `Format` produces. Sections mirror the
 * USERS.md "Default Briefing Structure" so a future renderer (§3.4) can
 * walk the structure without further parsing. Each section may be a
 * gap — the verifier and the failure-state UI honor that explicitly.
 */
export interface FormattedBriefing {
    readonly appointment: { readonly text: string; readonly source: SourceReference | null };
    readonly demographics: { readonly text: string; readonly source: SourceReference };
    readonly activeDiagnoses: readonly { readonly text: string; readonly source: SourceReference }[];
    /**
     * §3.3: the medication section becomes a `Gap` when the verifier
     * reports a safety hard stop (allergies or medications unavailable).
     * The §3.4 UI must render the gap as "Medication summary unavailable"
     * — never as an empty list, which would read as "no medications".
     */
    readonly currentMedications: readonly { readonly text: string; readonly source: SourceReference }[] | Gap;
    readonly recentLabs: readonly { readonly text: string; readonly source: SourceReference }[] | Gap;
    readonly allergies: readonly { readonly text: string; readonly source: SourceReference }[];
    readonly recentEncounters: readonly { readonly text: string; readonly source: SourceReference }[] | Gap;
}

export interface PersistedRecord {
    readonly conversationId: string;
    readonly requestId: string;
    readonly persistedAt: string;
}
