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
    // §4.2: UC2 lab-trend claims cite rows from `snapshot.labHistory`
    // (a separate slot from `snapshot.labs` because the standard
    // briefing's recent-labs panel and the trend's analyte-scoped
    // history have different lookback windows). Index both into the
    // same `labs` map so the verifier resolves trend citations the
    // same way it resolves single-value briefing citations.
    const history = snapshot.labHistory;
    if (history !== null && !('kind' in history)) {
        for (const l of history.observations) {
            labs.set(l.source.recordId, l);
        }
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

/**
 * Match `YYYY-MM-DD` substrings in a claim. The §4.2 strengthened
 * lab rule asks: if the claim text mentions a date, that date must
 * match the resolved row's `observedAt`. We pull every date-shaped
 * substring in the claim and only enforce when ≥1 is present —
 * "A1c was 9.4" with no date stays acceptable, but "A1c was 9.4 on
 * 2026-04-10" must match the cited row's `observedAt`.
 */
const DATE_SUBSTRING_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

const claimMentionsDate = (claim: Claim): readonly string[] =>
    claim.text.match(DATE_SUBSTRING_RE) ?? [];

const matchesLab = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const lab = idx.labs.get(ref.recordId);
    if (lab === undefined) return false;
    // Layer 1 (§3.3): the analyte AND value of the cited row both
    // appear in the claim text. Refuses "A1c trending up" with no
    // number; the §3.4 UI renders the claim as fact and the user
    // can't spot a fabricated number otherwise.
    if (!containsCI(claim.text, lab.analyte) || !containsCI(claim.text, lab.value)) {
        return false;
    }

    // Layer 2 (§4.2): if the claim mentions a date, at least one
    // of the date substrings must match the cited row's
    // `observedAt`. A claim that omits dates entirely is still
    // acceptable — the rule is "if you write a date, write the
    // right one", not "every claim must carry a date". Same for
    // the unit token below.
    const dates = claimMentionsDate(claim);
    if (dates.length > 0) {
        const observedAt = lab.observedAt;
        if (observedAt === null || !dates.includes(observedAt)) {
            return false;
        }
    }

    // Layer 3 (§4.2): if the resolved row has a non-null `unit`,
    // the claim text must NOT carry a *different* unit-like token
    // adjacent to the cited value. Asymmetric — a claim that omits
    // the unit entirely is still acceptable; the rule is "if you
    // write a unit, write the right one".
    //
    // A "unit-like token" here is one containing `%` or `/` (the two
    // characters that don't appear in English prose adjacent to a
    // number). This heuristic catches the common confusions —
    // "9.4 mg/dL" vs "9.4 %" — without false-positives on glue
    // words like "on" in "9.4 on 2026-04-15".
    const unit = lab.unit;
    if (unit !== null && unit.length > 0) {
        const escapedValue = lab.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const adjacentRe = new RegExp(`${escapedValue}\\s*([%/A-Za-z][\\w/%]*)`, 'g');
        for (const m of claim.text.matchAll(adjacentRe)) {
            const trailing = m[1];
            if (trailing === undefined || trailing.length === 0) continue;
            // Only enforce when the trailing token looks like a unit.
            const looksLikeUnit = trailing.includes('%') || trailing.includes('/');
            if (!looksLikeUnit) continue;
            if (!containsCI(trailing, unit)) {
                return false;
            }
        }
    }

    return true;
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

        // §4.2 strengthening for `lab` category: a trend claim cites
        // multiple values (one ref per value), and every ref must
        // resolve AND its content match the claim text. The pre-§4.2
        // first-resolves-wins loop allowed a claim that mixed real
        // ids with fabricated ones to slip through; the strict pass
        // refuses any unresolved or non-matching ref.
        if (claim.category === 'lab') {
            let labReject: string | null = null;
            for (const ref of claim.sourceReferences) {
                if (!check.resolves(ref, idx)) {
                    labReject = REJECT_UNRESOLVED;
                    break;
                }
                if (
                    check.contentMatches !== undefined
                    && !check.contentMatches(claim, ref, idx)
                ) {
                    labReject = REJECT_CONTENT;
                    break;
                }
            }
            if (labReject !== null) {
                rejected.push({ claim, reason: labReject });
                continue;
            }
            accepted.push(claim);
            continue;
        }

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
