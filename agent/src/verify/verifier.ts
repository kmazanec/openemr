import type {
    Allergy,
    Diagnosis,
    Encounter,
    LabObservation,
    Medication,
    SourceReference,
} from '../snapshot/types.js';
import type {
    BriefingSnapshot,
    Claim,
    ClaimLedger,
    Gap,
    VerifiedLedger,
} from '../graph/types.js';

/**
 * §3.3 verification gate. ARCHITECTURE.md §"Verification Architecture"
 * pins the contract:
 *
 *  - every claim must carry at least one source reference;
 *  - the reference must resolve to a record actually present in the
 *    snapshot (no hallucinated record IDs);
 *  - the claim text must mention the deterministic field of the cited
 *    record (med name, lab analyte+value, allergy substance, ICD code or
 *    label, encounter date or type, appointment startAt/type/reason,
 *    patient identity);
 *  - safety-critical categories (allergy, medication) fail closed when
 *    the underlying snapshot data is unavailable.
 *
 * The verifier is a pure function over `(snapshot, ledger)` so the graph
 * node stays a thin async adapter and the deterministic logic is
 * exhaustively unit-testable.
 */

const REJECT_NO_SOURCE = 'missing-source-references' as const;
const REJECT_UNRESOLVED = 'source-record-not-in-snapshot' as const;
const REJECT_CONTENT = 'claim-text-does-not-match-source-fields' as const;
const REJECT_HARD_STOP = 'safety-critical-data-unavailable' as const;

export const HARD_STOP_ALLERGIES_UNAVAILABLE = 'allergies-unavailable' as const;
export const HARD_STOP_MEDICATIONS_UNAVAILABLE = 'medications-unavailable' as const;

export type HardStop =
    | typeof HARD_STOP_ALLERGIES_UNAVAILABLE
    | typeof HARD_STOP_MEDICATIONS_UNAVAILABLE;

const isGap = <T>(v: readonly T[] | Gap): v is Gap =>
    !Array.isArray(v) && (v as Gap).kind === 'gap';

const containsCI = (haystack: string, needle: string): boolean =>
    needle.length > 0 && haystack.toLowerCase().includes(needle.toLowerCase());

interface SnapshotIndex {
    readonly medications: ReadonlyMap<string, Medication>;
    readonly allergies: ReadonlyMap<string, Allergy>;
    readonly diagnoses: ReadonlyMap<string, Diagnosis>;
    readonly labs: ReadonlyMap<string, LabObservation>;
    readonly encounters: ReadonlyMap<string, Encounter>;
    readonly appointmentId: string | null;
    readonly patientRecordId: string;
}

const buildIndex = (snapshot: BriefingSnapshot): SnapshotIndex => {
    // The current `BriefingSnapshot` type pins `medications`/`allergies`
    // as arrays only — Retrieve fails the whole graph if those tools
    // error. The verifier still tolerates a gap shape on every category
    // because a future widening of the snapshot type to allow
    // safety-critical gaps must not silently iterate `kind: 'gap'` as if
    // it were a record. The hard-stop rule below converts a gap into a
    // dropped claim; this helper only shields `for…of`.
    const medications = new Map<string, Medication>();
    if (!isGap(snapshot.medications as readonly Medication[] | Gap)) {
        for (const m of snapshot.medications) medications.set(m.source.recordId, m);
    }

    const allergies = new Map<string, Allergy>();
    if (!isGap(snapshot.allergies as readonly Allergy[] | Gap)) {
        for (const a of snapshot.allergies) allergies.set(a.source.recordId, a);
    }

    const diagnoses = new Map<string, Diagnosis>();
    for (const d of snapshot.diagnoses) diagnoses.set(d.source.recordId, d);

    const labs = new Map<string, LabObservation>();
    if (!isGap(snapshot.labs)) {
        for (const l of snapshot.labs) labs.set(l.source.recordId, l);
    }

    const encounters = new Map<string, Encounter>();
    if (!isGap(snapshot.encounters)) {
        for (const e of snapshot.encounters) encounters.set(e.source.recordId, e);
    }

    return {
        medications,
        allergies,
        diagnoses,
        labs,
        encounters,
        appointmentId: snapshot.appointment?.source.recordId ?? null,
        patientRecordId: snapshot.patient.source.recordId,
    };
};

const matchesMedication = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const med = idx.medications.get(ref.recordId);
    if (med === undefined) return false;
    return containsCI(claim.text, med.name);
};

const matchesLab = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const lab = idx.labs.get(ref.recordId);
    if (lab === undefined) return false;
    // Lab claims must cite both the analyte and the value — the verifier
    // refuses claims like "A1c trending up" with no number, because §3.4 UI
    // renders them as fact and the user has no way to spot a fabricated
    // number against the cited Observation row.
    return containsCI(claim.text, lab.analyte) && containsCI(claim.text, lab.value);
};

/**
 * NKDA ("no known drug allergies") is the data-layer encoding for
 * "patient has no allergies on file" — it is a marker, not a substance.
 * Clinicians and models phrase it many ways ("no known drug allergies",
 * "NKDA", "none reported", "patient denies allergies"). The substring
 * rule we use for real allergens (`containsCI(claim.text, substance)`)
 * is the wrong shape here: there is no substance to mention, and the
 * claim *should* be allowed to use natural prose.
 *
 * The list below is the closed set of phrasings the verifier accepts
 * for an NKDA-grounded claim. New phrasings should be added with a
 * unit test (see `verifier.test.ts` "accepts NKDA-shaped allergy
 * claims …"). We deliberately keep this short — the verifier is the
 * deterministic gate, and a permissive `/no.*allerg/i` would also
 * accept "no penicillin allergy" against an NKDA record, which is
 * not the same statement.
 */
const NKDA_PATTERNS: readonly RegExp[] = [
    /\bnkda\b/i,
    /\bno known (drug )?allerg(y|ies)\b/i,
    /\bno (drug )?allergies on file\b/i,
    /\bnone reported\b/i,
    /\bpatient denies (drug )?allergies\b/i,
    /\bno reported allergies\b/i,
];

const matchesAllergy = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const allergy = idx.allergies.get(ref.recordId);
    if (allergy === undefined) return false;
    if (allergy.substance.toUpperCase() === 'NKDA') {
        return NKDA_PATTERNS.some((p) => p.test(claim.text));
    }
    return containsCI(claim.text, allergy.substance);
};

const matchesDiagnosis = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const dx = idx.diagnoses.get(ref.recordId);
    if (dx === undefined) return false;
    return containsCI(claim.text, dx.code) || containsCI(claim.text, dx.label);
};

const matchesEncounter = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const enc = idx.encounters.get(ref.recordId);
    if (enc === undefined) return false;
    if (enc.encounterDate !== null && containsCI(claim.text, enc.encounterDate)) return true;
    if (enc.type !== null && containsCI(claim.text, enc.type)) return true;
    return false;
};

interface CategoryCheck {
    readonly resolves: (ref: SourceReference, idx: SnapshotIndex) => boolean;
    /**
     * `contentMatches` returns true when the claim text mentions the
     * deterministic field of the resolved source record. Categories
     * whose source records have no free-text content beyond identity
     * (appointment, identity) omit this — the resolution check carries
     * the verification load.
     */
    readonly contentMatches?: (claim: Claim, ref: SourceReference, idx: SnapshotIndex) => boolean;
}

const CHECKS: Record<Claim['category'], CategoryCheck> = {
    medication: {
        resolves: (ref, idx) => idx.medications.has(ref.recordId),
        contentMatches: matchesMedication,
    },
    lab: {
        resolves: (ref, idx) => idx.labs.has(ref.recordId),
        contentMatches: matchesLab,
    },
    allergy: {
        resolves: (ref, idx) => idx.allergies.has(ref.recordId),
        contentMatches: matchesAllergy,
    },
    diagnosis: {
        resolves: (ref, idx) => idx.diagnoses.has(ref.recordId),
        contentMatches: matchesDiagnosis,
    },
    encounter: {
        resolves: (ref, idx) => idx.encounters.has(ref.recordId),
        contentMatches: matchesEncounter,
    },
    appointment: {
        resolves: (ref, idx) => idx.appointmentId !== null && idx.appointmentId === ref.recordId,
    },
    identity: {
        resolves: (ref, idx) =>
            ref.recordType.toLowerCase() === 'patient' && ref.recordId === idx.patientRecordId,
    },
};

const computeHardStops = (snapshot: BriefingSnapshot): readonly HardStop[] => {
    const stops: HardStop[] = [];
    // Allergies and medications are fail-closed safety categories
    // (ARCHITECTURE.md §"Safety Rules"). The current `BriefingSnapshot`
    // shape always carries them as concrete arrays — Retrieve fails the
    // whole graph if either tool errored. Keeping the verifier check in
    // place protects against a future widening of the type to allow gaps,
    // and makes the policy testable in isolation.
    if (isGap(snapshot.allergies as readonly Allergy[] | Gap)) {
        stops.push(HARD_STOP_ALLERGIES_UNAVAILABLE);
    }
    if (isGap(snapshot.medications as readonly Medication[] | Gap)) {
        stops.push(HARD_STOP_MEDICATIONS_UNAVAILABLE);
    }
    return stops;
};

const isStoppedCategory = (category: Claim['category'], stops: readonly HardStop[]): boolean => {
    if (stops.length === 0) return false;
    if (category === 'medication') return true;
    if (category === 'allergy' && stops.includes(HARD_STOP_ALLERGIES_UNAVAILABLE)) return true;
    return false;
};

export const verifyLedger = (
    snapshot: BriefingSnapshot,
    ledger: ClaimLedger,
): VerifiedLedger => {
    const idx = buildIndex(snapshot);
    const stops = computeHardStops(snapshot);

    const accepted: Claim[] = [];
    const rejected: { claim: Claim; reason: string }[] = [];

    for (const claim of ledger.claims) {
        if (claim.sourceReferences.length === 0) {
            rejected.push({ claim, reason: REJECT_NO_SOURCE });
            continue;
        }

        if (isStoppedCategory(claim.category, stops)) {
            rejected.push({ claim, reason: REJECT_HARD_STOP });
            continue;
        }

        const check = CHECKS[claim.category];
        const resolvedRef = claim.sourceReferences.find((ref) => check.resolves(ref, idx));
        if (resolvedRef === undefined) {
            rejected.push({ claim, reason: REJECT_UNRESOLVED });
            continue;
        }

        if (check.contentMatches !== undefined && !check.contentMatches(claim, resolvedRef, idx)) {
            rejected.push({ claim, reason: REJECT_CONTENT });
            continue;
        }

        accepted.push(claim);
    }

    return {
        passed: rejected.length === 0 && stops.length === 0,
        accepted,
        rejected,
        safetyHardStops: stops,
    };
};
