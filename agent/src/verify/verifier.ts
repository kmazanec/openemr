import type {
    Allergy,
    Diagnosis,
    Encounter,
    LabObservation,
    MedicationStatement,
    Prescription,
    Reminder,
    SourceReference,
} from '../snapshot/types.js';
import type {
    BriefingSnapshot,
    Claim,
    ClaimLedger,
    EvidenceRetrieverOutput,
    EvidenceSnippet,
    ExtractedFactSnippet,
    Gap,
    VerifiedLedger,
} from '../graph/types.js';
import {
    isLowConfidence,
    parseConfidenceSignal,
    type ConfidenceSignal,
} from './confidenceThresholds.js';

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
 *  - safety-critical categories (allergy, prescription) fail closed
 *    when the underlying snapshot data is unavailable.
 *
 * §C.5 extends the resolution dispatch to the unified `SourceReference`
 * shape — `chart` is the W1 carry-forward, `extracted_document` resolves
 * against this turn's `documentEvidenceRetriever` snippets (page + bbox
 * must equal the recorded extraction; quote substring-matches the
 * snippet's quote or value), `guideline` resolves against this turn's
 * `evidenceRetriever` snippets (chunk id + section must match; quote
 * substring-matches the chunk text). Confidence hard-stops fire after
 * resolution succeeds and before category fail-closed checks.
 *
 * The verifier is a pure function over `(snapshot, ledger, ctx)` so the
 * graph node stays a thin async adapter and the deterministic logic is
 * exhaustively unit-testable.
 */

const REJECT_NO_SOURCE = 'missing-source-references' as const;
const REJECT_UNRESOLVED = 'source-record-not-in-snapshot' as const;
const REJECT_CONTENT = 'claim-text-does-not-match-source-fields' as const;
const REJECT_HARD_STOP = 'safety-critical-data-unavailable' as const;
const REJECT_LOW_CONFIDENCE = 'low-confidence-extraction' as const;
// A `recommendation`-category claim must lead with a guideline-typed
// source ref. The synthesizer prompt teaches this; the verifier
// enforces it so a chart-only claim mis-categorised as a
// recommendation cannot reach the panel under the "Recommendations"
// header.
const REJECT_RECOMMENDATION_NEEDS_GUIDELINE = 'recommendation-missing-guideline-source' as const;

export const HARD_STOP_ALLERGIES_UNAVAILABLE = 'allergies-unavailable' as const;
export const HARD_STOP_PRESCRIPTIONS_UNAVAILABLE = 'prescriptions-unavailable' as const;

export type HardStop =
    | typeof HARD_STOP_ALLERGIES_UNAVAILABLE
    | typeof HARD_STOP_PRESCRIPTIONS_UNAVAILABLE;

const isGap = <T>(v: readonly T[] | Gap): v is Gap =>
    !Array.isArray(v) && (v as Gap).kind === 'gap';

const containsCI = (haystack: string, needle: string): boolean =>
    needle.length > 0 && haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * Paraphrase-tolerant substring match. Normalizes both sides to
 * lowercase, collapses whitespace runs to a single space, and strips
 * a small set of "decorative" punctuation tokens (commas, semicolons,
 * colons, parentheses, single/double quotes, em/en dashes). Digits,
 * units, percent signs, comparison operators, and arithmetic
 * characters are preserved — so "A1c 8.4 %" still differs from
 * "A1c 8.5 %" but matches "A1c 8.4%" or "A1c, 8.4 percent" (the
 * percent-spelled-out case still requires `containsCI` to pass on the
 * fast path; this normalization only catches whitespace/punctuation
 * drift, not lexical paraphrase).
 *
 * Used by the guideline and extracted-document resolvers as a
 * fallback after `containsCI` fails — the synthesizer paraphrases
 * substantively often enough that strict substring is paraphrase-
 * hostile, but we don't want to widen all the way to a token-bag
 * match (which the chart `tolerantTokenBagMatch` does for chart-side
 * content matching).
 */
const NORMALIZE_DROP = /[,;:()'"–—]/g;
const NORMALIZE_WS = /\s+/g;
const normalizeForMatch = (s: string): string =>
    s.toLowerCase().replace(NORMALIZE_DROP, ' ').replace(NORMALIZE_WS, ' ').trim();
const containsNormalized = (haystack: string, needle: string): boolean => {
    if (needle.length === 0) return false;
    const n = normalizeForMatch(needle);
    if (n.length === 0) return false;
    return normalizeForMatch(haystack).includes(n);
};

/**
 * Tolerant content matcher. Falls back to a token-bag comparison when
 * the cheap substring rule fails, so the verifier doesn't reject valid
 * claims for trivial wording differences:
 *
 *   - trailing-s plurals: source "NSAIDs" vs claim "NSAID allergy"
 *     (the model may legitimately drop the plural when binding the term
 *     to the noun "allergy" — both refer to the same chart row).
 *   - LOINC-style comma-swapped analyte names: source "Glucose, Fasting"
 *     vs claim "Fasting glucose 93 mg/dL on 2026-04-30".
 *
 * The fallback splits the source field on whitespace and commas, drops
 * empty tokens, and requires every source token to appear as a
 * word-boundary substring of the claim. Stop-suffix 's' is dropped from
 * tokens longer than 3 characters before matching; below that length it
 * matters semantically (e.g. "as" vs "a"). The substring fast path
 * still wins when it would — the fallback only fires after `containsCI`
 * has already returned false.
 *
 * Stricter than a generic fuzzy-match: a claim that omits a token
 * entirely (e.g. "no allergies on file" against an "NSAIDs" record)
 * still rejects. Looser than a raw substring: word order, plurality,
 * and comma-separation are tolerated.
 */
const tokenize = (s: string): readonly string[] =>
    s
        .toLowerCase()
        .split(/[\s,]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

const stripPluralS = (token: string): string =>
    token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;

const claimMentionsToken = (claimLower: string, token: string): boolean => {
    if (token.length === 0) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word boundaries on either side so "ase" doesn't match "lipase".
    // Singular+optional-s on the right so "NSAID" matches "NSAIDs".
    const re = new RegExp(`\\b${escaped}s?\\b`, 'u');
    return re.test(claimLower);
};

const tolerantContentMatch = (claimText: string, sourceField: string): boolean => {
    if (containsCI(claimText, sourceField)) return true;
    const tokens = tokenize(sourceField).map(stripPluralS);
    if (tokens.length === 0) return false;
    const claimLower = claimText.toLowerCase();
    return tokens.every((t) => claimMentionsToken(claimLower, t));
};

/**
 * Lab-analyte alias groups: every group is a set of mutually-equivalent
 * names for the same analyte. Chart `analyte` strings come from the
 * snapshot endpoint's lab adapter, which preserves the LOINC-shaped
 * display name verbatim ("Hemoglobin A1c", "Blood Urea Nitrogen",
 * "LDL Cholesterol (calculated)"). Synthesizers — and clinicians —
 * habitually use compact medical abbreviations ("HbA1c", "BUN",
 * "LDL cholesterol") that don't word-for-word reproduce the chart's
 * verbose form, so the strict token-bag rule rejected accurate
 * claims as unverified.
 *
 * The alias check is asymmetric: we only consult it when the chart's
 * `analyte` matches a group, and then accept the claim if it mentions
 * ANY equivalent name from the same group. The numeric value, date,
 * and unit checks downstream still gate fabrication — we relax the
 * naming rule, not the verification surface.
 *
 * Adding a new alias is a one-line change; keep the canonical chart
 * name first in each tuple so a future grep is obvious.
 */
const LAB_ANALYTE_ALIASES: readonly (readonly string[])[] = [
    ['Hemoglobin A1c', 'HbA1c', 'A1c', 'Glycated hemoglobin', 'Glycohemoglobin'],
    ['Blood Urea Nitrogen', 'BUN', 'Urea nitrogen'],
    ['LDL Cholesterol (calculated)', 'LDL Cholesterol', 'LDL-C', 'LDL'],
    ['HDL Cholesterol', 'HDL-C', 'HDL'],
    ['Cholesterol, Total', 'Total cholesterol', 'Total chol'],
    ['Glucose, Fasting', 'Fasting glucose', 'FPG', 'Fasting plasma glucose'],
    ['eGFR (MDRD)', 'eGFR', 'Estimated GFR', 'Estimated glomerular filtration rate'],
    ['eGFR (CKD-EPI)', 'eGFR', 'Estimated GFR'],
    ['Triglycerides', 'TG', 'Triglyceride'],
    ['Non-HDL Cholesterol', 'Non-HDL', 'Non-HDL-C'],
];

const matchesLabAnalyte = (claimText: string, chartAnalyte: string): boolean => {
    if (tolerantContentMatch(claimText, chartAnalyte)) return true;
    const claimLower = claimText.toLowerCase();
    const chartLower = chartAnalyte.toLowerCase();
    for (const group of LAB_ANALYTE_ALIASES) {
        const groupLower = group.map((g) => g.toLowerCase());
        if (!groupLower.includes(chartLower)) continue;
        // The chart's analyte is in this group; accept if the claim
        // mentions any member of the group as a substring (case-
        // insensitive). Substring rather than token-bag because alias
        // names are short ("BUN", "HbA1c") and word-boundary matching
        // gets fiddly across mixed-case tokens like "HbA1c".
        if (groupLower.some((alias) => claimLower.includes(alias))) {
            return true;
        }
    }
    return false;
};

/**
 * Pharmaceutical descriptors (route + dosage form) that the chart's
 * `drug` field carries from RxNorm-style display strings ("Metformin
 * hydrochloride 500 MG Oral Tablet") but that the synthesizer
 * legitimately omits when re-rendering as natural prose ("Metformin
 * 500 mg twice daily"). The drug name and strength remain
 * load-bearing for safety; these descriptors do not.
 */
const PRESCRIPTION_FORM_DESCRIPTORS: ReadonlySet<string> = new Set([
    'oral',
    'tablet',
    'capsule',
    'caplet',
    'solution',
    'suspension',
    'injection',
    'injectable',
    'syrup',
    'cream',
    'ointment',
    'patch',
    'inhaler',
    'spray',
    'drop',
    'lozenge',
    'powder',
    'gel',
    'extended-release',
    'er',
    'xr',
    'sr',
    'ir',
    'la',
    'cr',
    'mr',
    'odt',
    'sl',
]);

const matchesDrugName = (claimText: string, chartDrugName: string): boolean => {
    if (containsCI(claimText, chartDrugName)) return true;
    const tokens = tokenize(chartDrugName)
        .map(stripPluralS)
        .filter((t) => !PRESCRIPTION_FORM_DESCRIPTORS.has(t));
    if (tokens.length === 0) return false;
    const claimLower = claimText.toLowerCase();
    return tokens.every((t) => claimMentionsToken(claimLower, t));
};

/**
 * §A.5 re-export. `loadPriorContext` resolves replayed citations
 * against the current turn's snapshot using the same indexer the
 * verifier uses, per `W2_ARCHITECTURE.md` §"Prior-turn context"
 * §"Persistence". Sharing the indexer keeps a single source of truth
 * for "what is in the snapshot" — a future change (a new safety-
 * critical category, a renamed slot) propagates to prior-turn fact
 * resolution automatically.
 */
export interface SnapshotIndex {
    readonly prescriptions: ReadonlyMap<string, Prescription>;
    readonly allergies: ReadonlyMap<string, Allergy>;
    readonly diagnoses: ReadonlyMap<string, Diagnosis>;
    readonly labs: ReadonlyMap<string, LabObservation>;
    readonly encounters: ReadonlyMap<string, Encounter>;
    readonly reminders: ReadonlyMap<string, Reminder>;
    readonly medications: ReadonlyMap<string, MedicationStatement>;
    readonly appointmentId: string | null;
    readonly patientRecordId: string;
}

/**
 * Resolve a single citation against an indexed snapshot. Returns the
 * raw row when the citation's `source_id` is present in the matching
 * slot; returns `null` for opaque-pointer mode (the citation came
 * from a prior turn whose snapshot was different, or the citation
 * names an `appointment`/`identity` row that the verifier index
 * doesn't materialize as a row — the supervisor can still route on
 * `source_type` without a resolved value).
 *
 * §A.5 surface is intentionally chart-only: `extracted_document` and
 * `guideline` resolution lands in A.8 alongside the synthesizer
 * resolution rules. Today, replayed non-chart citations arrive as
 * opaque pointers — still useful to the supervisor for routing
 * ("last turn cited 1 guideline"), still safe to omit from the
 * synthesizer's prompt body.
 */
export const resolveSourceReference = (
    idx: SnapshotIndex,
    ref: SourceReference,
): unknown => {
    if (ref.source_type !== 'chart') return null;
    const id = ref.source_id;
    return (
        idx.prescriptions.get(id)
        ?? idx.allergies.get(id)
        ?? idx.diagnoses.get(id)
        ?? idx.labs.get(id)
        ?? idx.encounters.get(id)
        ?? idx.reminders.get(id)
        ?? idx.medications.get(id)
        ?? null
    );
};

export const buildSnapshotIndex = (snapshot: BriefingSnapshot): SnapshotIndex => {
    // The current `BriefingSnapshot` type pins `prescriptions`/
    // `allergies` as arrays only — Retrieve fails the whole graph if
    // those tools error. The verifier still tolerates a gap shape on
    // every category because a future widening of the snapshot type to
    // allow safety-critical gaps must not silently iterate
    // `kind: 'gap'` as if it were a record. The hard-stop rule below
    // converts a gap into a dropped claim; this helper only shields
    // `for…of`.
    const prescriptions = new Map<string, Prescription>();
    if (!isGap(snapshot.prescriptions as readonly Prescription[] | Gap)) {
        for (const p of snapshot.prescriptions) prescriptions.set(p.source.source_id, p);
    }

    const allergies = new Map<string, Allergy>();
    if (!isGap(snapshot.allergies as readonly Allergy[] | Gap)) {
        for (const a of snapshot.allergies) allergies.set(a.source.source_id, a);
    }

    const diagnoses = new Map<string, Diagnosis>();
    for (const d of snapshot.diagnoses) diagnoses.set(d.source.source_id, d);

    const labs = new Map<string, LabObservation>();
    if (!isGap(snapshot.labs)) {
        for (const l of snapshot.labs) labs.set(l.source.source_id, l);
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
            labs.set(l.source.source_id, l);
        }
    }

    const encounters = new Map<string, Encounter>();
    if (!isGap(snapshot.encounters)) {
        for (const e of snapshot.encounters) encounters.set(e.source.source_id, e);
    }

    const reminders = new Map<string, Reminder>();
    if (!isGap(snapshot.reminders)) {
        for (const r of snapshot.reminders) reminders.set(r.source.source_id, r);
    }

    const medications = new Map<string, MedicationStatement>();
    if (!isGap(snapshot.medications)) {
        for (const m of snapshot.medications) medications.set(m.source.source_id, m);
    }

    return {
        prescriptions,
        allergies,
        diagnoses,
        labs,
        encounters,
        reminders,
        medications,
        appointmentId: snapshot.appointment?.source.source_id ?? null,
        patientRecordId: snapshot.patient.source.source_id,
    };
};

const matchesPrescription = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const rx = idx.prescriptions.get(ref.source_id);
    if (rx === undefined) return false;
    return matchesDrugName(claim.text, rx.name);
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

/**
 * §4.3 UC3: prescription-change claims must surface the documented
 * provenance fields rather than model inference. The deterministic
 * `prescriptionChangeBranch` builds claims that mention only fields
 * the source row carries; this rule pins the inverse — when the
 * source row has a prescriber or indication, the claim text MUST
 * contain it. Omission is acceptable only when the source field is
 * null (USERS.md UC3 promises *documented* provenance, so an
 * undocumented indication should not be invented).
 */
const matchesPrescriptionChange = (
    claim: Claim,
    ref: SourceReference,
    idx: SnapshotIndex,
): boolean => {
    const rx = idx.prescriptions.get(ref.source_id);
    if (rx === undefined) return false;
    if (!matchesDrugName(claim.text, rx.name)) return false;
    if (
        rx.indication !== null
        && rx.indication.length > 0
        && !tolerantContentMatch(claim.text, rx.indication)
    ) {
        return false;
    }
    // Prescriber names ("Dr. Patel") shouldn't be plural-stripped, but
    // word-order tolerance still helps when the model writes the name
    // in last-first or first-last order. tolerantContentMatch's
    // tokenizer handles that without changing the no-omissions rule.
    if (
        rx.prescriber !== null
        && rx.prescriber.length > 0
        && !tolerantContentMatch(claim.text, rx.prescriber)
    ) {
        return false;
    }
    return true;
};


const matchesLab = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const lab = idx.labs.get(ref.source_id);
    if (lab === undefined) return false;
    // Layer 1: the analyte AND value of the cited row both appear in
    // the claim text. Refuses "A1c trending up" with no number; the
    // synthesizer renders the claim as fact and the user can't spot a
    // fabricated number otherwise.
    //
    // The analyte uses the tolerant matcher because LOINC names often
    // arrive comma-swapped ("Glucose, Fasting") while the synthesizer
    // re-orders into natural English ("Fasting glucose"). The value
    // stays on strict containsCI — fabricated numbers are exactly what
    // this rule exists to catch, so loosening it is unsafe.
    if (!matchesLabAnalyte(claim.text, lab.analyte) || !containsCI(claim.text, lab.value)) {
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
    const allergy = idx.allergies.get(ref.source_id);
    if (allergy === undefined) return false;
    if (allergy.substance.toUpperCase() === 'NKDA') {
        return NKDA_PATTERNS.some((p) => p.test(claim.text));
    }
    return tolerantContentMatch(claim.text, allergy.substance);
};

const matchesDiagnosis = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const dx = idx.diagnoses.get(ref.source_id);
    if (dx === undefined) return false;
    // Codes are exact identifiers (E11.9) — no fuzziness wanted.
    // Labels are free text and benefit from the tolerant matcher.
    return containsCI(claim.text, dx.code) || tolerantContentMatch(claim.text, dx.label);
};

const matchesEncounter = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const enc = idx.encounters.get(ref.source_id);
    if (enc === undefined) return false;
    if (enc.encounterDate !== null && containsCI(claim.text, enc.encounterDate)) return true;
    if (enc.type !== null && containsCI(claim.text, enc.type)) return true;
    return false;
};

/**
 * §4.6.3: reminder claims must surface BOTH the human-readable item
 * name AND the actionable due-status token. The combined check
 * refuses claims that name the right item with the wrong urgency
 * ("mammogram is due" against an `overdue` reminder is a different
 * statement than "mammogram is overdue") — reminders are short by
 * nature, so the rule has to be precise about the two pieces that
 * actually carry meaning.
 */
const matchesReminder = (claim: Claim, ref: SourceReference, idx: SnapshotIndex): boolean => {
    const reminder = idx.reminders.get(ref.source_id);
    if (reminder === undefined) return false;
    if (!tolerantContentMatch(claim.text, reminder.itemTitle)) return false;
    // dueStatus is a closed enum ("due", "overdue", "soon") — keep the
    // strict containsCI; loosening it would mush "due" into "soon".
    if (!containsCI(claim.text, reminder.dueStatus)) return false;
    return true;
};

/**
 * §4.6.4: medication-statement claims need to mention the
 * medication name. The rule is intentionally looser than the
 * prescription rule because patient-reported entries often lack the
 * structured metadata (no formal prescriber, no clinic indication)
 * that the prescription rule keys on. The whole point of this surface
 * is "the patient said something the clinic didn't write" — being too
 * strict about what *else* the claim must contain would push the
 * synthesizer to skip it.
 */
const matchesMedicationStatement = (
    claim: Claim,
    ref: SourceReference,
    idx: SnapshotIndex,
): boolean => {
    const stmt = idx.medications.get(ref.source_id);
    if (stmt === undefined) return false;
    return tolerantContentMatch(claim.text, stmt.name);
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
    prescription: {
        resolves: (ref, idx) => idx.prescriptions.has(ref.source_id),
        contentMatches: matchesPrescription,
    },
    prescription_change: {
        resolves: (ref, idx) => idx.prescriptions.has(ref.source_id),
        contentMatches: matchesPrescriptionChange,
    },
    lab: {
        resolves: (ref, idx) => idx.labs.has(ref.source_id),
        contentMatches: matchesLab,
    },
    allergy: {
        resolves: (ref, idx) => idx.allergies.has(ref.source_id),
        contentMatches: matchesAllergy,
    },
    diagnosis: {
        resolves: (ref, idx) => idx.diagnoses.has(ref.source_id),
        contentMatches: matchesDiagnosis,
    },
    family_history: {
        // F.5e — family_history claims primarily come from
        // `extracted_document` source_type (the briefing snapshot has
        // no chart-side family-history map today). The chart-source
        // path runs through this `resolves` and always returns false:
        // the snapshot has no `idx.familyHistory.*` to look against,
        // so a chart-typed family_history claim is treated as
        // unresolved (REJECT_UNRESOLVED). The extracted_document path
        // bypasses CHECKS entirely.
        resolves: () => false,
    },
    encounter: {
        resolves: (ref, idx) => idx.encounters.has(ref.source_id),
        contentMatches: matchesEncounter,
    },
    appointment: {
        resolves: (ref, idx) => idx.appointmentId !== null && idx.appointmentId === ref.source_id,
    },
    identity: {
        // W1 identity rule was "recordType === 'Patient' AND recordId
        // matches"; in W2 the source_type is always 'chart' for
        // chart-derived citations, so the patient-vs-other-record
        // distinction lives in the locator. PatientAdapter emits
        // `locator.field = 'patient.*'`.
        resolves: (ref, idx) =>
            ref.source_type === 'chart' &&
            (ref.locator.field?.startsWith('patient.') ?? false) &&
            ref.source_id === idx.patientRecordId,
    },
    reminder: {
        resolves: (ref, idx) => idx.reminders.has(ref.source_id),
        contentMatches: matchesReminder,
    },
    medication_statement: {
        resolves: (ref, idx) => idx.medications.has(ref.source_id),
        contentMatches: matchesMedicationStatement,
    },
    recommendation: {
        // Recommendations require a guideline-typed primary ref. The
        // dispatch in `verifyLedger` short-circuits before this entry is
        // consulted; the slot exists only to keep `Record<ClaimCategory,
        // CategoryCheck>` exhaustive so a future ClaimCategory addition
        // can't quietly omit a check.
        resolves: () => false,
    },
};

export const computeHardStops = (snapshot: BriefingSnapshot): readonly HardStop[] => {
    const stops: HardStop[] = [];
    // Allergies and prescriptions are fail-closed safety categories
    // (ARCHITECTURE.md §"Safety Rules"). The current `BriefingSnapshot`
    // shape always carries them as concrete arrays — Retrieve fails the
    // whole graph if either tool errored. Keeping the verifier check in
    // place protects against a future widening of the type to allow gaps,
    // and makes the policy testable in isolation.
    if (isGap(snapshot.allergies as readonly Allergy[] | Gap)) {
        stops.push(HARD_STOP_ALLERGIES_UNAVAILABLE);
    }
    if (isGap(snapshot.prescriptions as readonly Prescription[] | Gap)) {
        stops.push(HARD_STOP_PRESCRIPTIONS_UNAVAILABLE);
    }
    return stops;
};

/**
 * Shared rule deciding whether a hard stop suppresses a given claim
 * category. Exported so `format.ts` (per-segment redaction) and any
 * UC-specific branch (e.g. UC3 prescriptionChangeBranch's pre-network
 * short-circuit) apply the exact same suppression policy. Accepts
 * `readonly string[]` — `VerifiedLedger.safetyHardStops` widens
 * `HardStop` at the type boundary, and the inclusions check below is
 * narrow enough to handle the wider type without losing exhaustiveness.
 */
export const isStoppedCategory = (
    category: Claim['category'],
    stops: readonly string[],
): boolean => {
    if (stops.length === 0) return false;
    // prescription_change is a prescription-category claim: the same
    // safety rules apply — if allergies-unavailable hard stop fires,
    // suppress UC3 output too. format.ts now imports this helper
    // directly, so the suppression policy lives in one place.
    if (category === 'prescription' || category === 'prescription_change') return true;
    if (category === 'allergy' && stops.includes(HARD_STOP_ALLERGIES_UNAVAILABLE)) return true;
    return false;
};

/**
 * §C.5 verifier context. Optional state slots the chart-only verifier
 * doesn't need but the extracted_document and guideline rules do:
 *
 *  - `documentEvidenceSnippets`: this turn's `documentEvidenceRetriever`
 *    output (state slot of the same name). The architecture text says
 *    "this turn's `extraction_artifacts`" — that's the source-of-truth
 *    table; the verifier resolves against the snippets the retriever
 *    actually produced this turn (the supervisor's narrowed query
 *    drives which artifacts get surfaced). A citation against an
 *    artifact the retriever didn't return is a fabricated citation,
 *    same as a chart citation against an unindexed record.
 *  - `evidenceRetrieverOutput`: this turn's `evidenceRetriever` output.
 *    `gap` indicates Pinecone outage — guideline citations under a
 *    gap reject as unresolved (the supervisor should have routed
 *    around).
 *  - `artifactConfidence`: per-artifact `confidence_signal` JSONB
 *    payload, keyed by `artifactId`. The verifier parses each entry
 *    via `parseConfidenceSignal` so a missing or malformed signal
 *    fails closed (low-confidence). When a snippet itself carries a
 *    `confidence` number, that's mixed in as the `selfReported` field
 *    if the per-artifact map didn't already supply one.
 */
export interface VerifyContext {
    readonly documentEvidenceSnippets?: readonly ExtractedFactSnippet[] | null;
    readonly evidenceRetrieverOutput?: EvidenceRetrieverOutput | null;
    readonly artifactConfidence?: ReadonlyMap<string, unknown>;
}

interface ExtractedDocIndex {
    /** Keyed by `${artifactId}::${fieldPath}`. */
    readonly byKey: ReadonlyMap<string, ExtractedFactSnippet>;
    readonly artifactIds: ReadonlySet<string>;
}

interface GuidelineIndex {
    readonly bySection: ReadonlyMap<string, EvidenceSnippet>;
    readonly available: boolean;
}

const buildExtractedDocIndex = (
    snippets: readonly ExtractedFactSnippet[] | null | undefined,
): ExtractedDocIndex => {
    const byKey = new Map<string, ExtractedFactSnippet>();
    const artifactIds = new Set<string>();
    if (snippets !== undefined && snippets !== null) {
        for (const s of snippets) {
            byKey.set(`${s.artifactId}::${s.fieldPath}`, s);
            artifactIds.add(s.artifactId);
        }
    }
    return { byKey, artifactIds };
};

const buildGuidelineIndex = (
    output: EvidenceRetrieverOutput | null | undefined,
): GuidelineIndex => {
    const bySection = new Map<string, EvidenceSnippet>();
    if (output === undefined || output === null) {
        return { bySection, available: false };
    }
    // A retriever output with a Gap indicates Pinecone outage. The
    // supervisor's contract is to route around the gap; if a guideline
    // citation reached us anyway, treat the index as unavailable so
    // the citation rejects as unresolved (rather than silently
    // accepting against an empty snippets array).
    if (output.gap !== null) {
        return { bySection, available: false };
    }
    for (const s of output.snippets) {
        bySection.set(`${s.chunkId}::${s.section}`, s);
    }
    return { bySection, available: true };
};

const arraysEqual = (
    a: readonly number[] | undefined,
    b: readonly number[] | undefined,
): boolean => {
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

/**
 * Resolve and content-match an `extracted_document` source reference.
 * Returns the matched snippet on success or a typed rejection reason
 * the caller pushes to the rejected list.
 *
 *  - source_id (= artifactId) + locator.field (= fieldPath) must
 *    identify exactly one snippet from this turn's retriever output.
 *  - locator.page must equal that snippet's page; locator.bbox must
 *    deep-equal its bbox (no fabricated bboxes — the architecture's
 *    explicit failure mode for this rule).
 *  - The claim's quote at the ref must substring-match the snippet's
 *    `quote` OR the stringified `value` at the same field path.
 *    Allowing `value` covers the case where the snippet's free-text
 *    OCR `quote` reads "A1c 9.4 % (H)" but the model paraphrases as
 *    "9.4" (matching the structured value).
 */
const resolveExtractedDocument = (
    ref: SourceReference,
    claim: Claim,
    idx: ExtractedDocIndex,
): { ok: true; snippet: ExtractedFactSnippet } | { ok: false; reason: string } => {
    if (!idx.artifactIds.has(ref.source_id)) {
        return { ok: false, reason: REJECT_UNRESOLVED };
    }
    const fieldPath = ref.locator.field;
    if (fieldPath === undefined) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    const snippet = idx.byKey.get(`${ref.source_id}::${fieldPath}`);
    if (snippet === undefined) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    if (ref.locator.page !== snippet.page) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    if (!arraysEqual(ref.locator.bbox, snippet.bbox)) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    // Substring-match against either the OCR quote or the stringified
    // structured value. The model is allowed to render numerically
    // ("9.4") even when the OCR quote was "A1c 9.4 % (H)". The
    // structured `value` is `unknown` because the extractor schema
    // varies — we only stringify the primitive types where the result
    // would be meaningful (objects/arrays would render as
    // "[object Object]" and aren't useful as substring needles).
    const valueStr =
        typeof snippet.value === 'string' ? snippet.value
            : typeof snippet.value === 'number' || typeof snippet.value === 'boolean'
                ? String(snippet.value)
                : '';
    const quoteOk =
        containsCI(snippet.quote, ref.quote)
        || (valueStr.length > 0 && containsCI(valueStr, ref.quote))
        || containsCI(claim.text, snippet.quote)
        || (valueStr.length > 0 && containsCI(claim.text, valueStr))
        // Normalized fallback for paraphrase-by-whitespace/punctuation.
        // Mirrors the `resolveGuideline` widening — extracted-document
        // OCR text often has decorative punctuation the synthesizer
        // drops, and we don't want strict substring to reject those.
        || containsNormalized(snippet.quote, ref.quote)
        || (valueStr.length > 0 && containsNormalized(valueStr, ref.quote))
        || containsNormalized(claim.text, snippet.quote)
        || (valueStr.length > 0 && containsNormalized(claim.text, valueStr));
    if (!quoteOk) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    return { ok: true, snippet };
};

/**
 * Copy artifact identity onto an accepted extracted_document claim's
 * primary ref. The synthesizer only emits artifactId (as `source_id`)
 * + locator + quote; the panel's document drawer needs `meta.document_uuid`
 * to construct the document fetch URL. Returns a new claim with the
 * primary ref's `meta` extended.
 */
const enrichExtractedDocClaim = (claim: Claim, snippet: ExtractedFactSnippet): Claim => {
    const refs = claim.sourceReferences;
    if (refs.length === 0) return claim;
    const primary = refs[0]!;
    const enrichedMeta = {
        ...(primary.meta ?? {}),
        document_uuid: snippet.documentUuid,
        ...(primary.meta?.extractor_version === undefined
            ? { extractor_version: snippet.extractorVersion }
            : {}),
    };
    const enrichedPrimary: SourceReference = { ...primary, meta: enrichedMeta };
    return { ...claim, sourceReferences: [enrichedPrimary, ...refs.slice(1)] };
};

/**
 * Copy publication metadata from the matched `EvidenceSnippet` onto
 * the accepted claim's primary guideline ref. The synthesizer only
 * emits chunkId + section + quote; the snippet carries the rest of the
 * metadata the panel needs to render a self-contained guideline drawer
 * (publication, title, year, source URL). Returns a new claim with the
 * primary ref's `meta` extended; non-primary refs (rare but allowed by
 * the schema) pass through untouched.
 */
const enrichGuidelineClaim = (claim: Claim, snippet: EvidenceSnippet): Claim => {
    const refs = claim.sourceReferences;
    if (refs.length === 0) return claim;
    const primary = refs[0]!;
    const enrichedMeta = {
        ...(primary.meta ?? {}),
        publication: snippet.publication,
        title: snippet.title,
        year: snippet.year,
        section: snippet.section,
        ...(snippet.url !== undefined ? { url: snippet.url } : {}),
        ...(primary.meta?.rerank_score === undefined
            ? { rerank_score: snippet.rerankScore }
            : {}),
    };
    const enrichedPrimary: SourceReference = { ...primary, meta: enrichedMeta };
    return { ...claim, sourceReferences: [enrichedPrimary, ...refs.slice(1)] };
};

const resolveGuideline = (
    ref: SourceReference,
    claim: Claim,
    idx: GuidelineIndex,
): { ok: true; snippet: EvidenceSnippet } | { ok: false; reason: string } => {
    if (!idx.available) {
        return { ok: false, reason: REJECT_UNRESOLVED };
    }
    const section = ref.locator.section;
    if (section === undefined) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    const snippet = idx.bySection.get(`${ref.source_id}::${section}`);
    if (snippet === undefined) {
        // Source_id present but in a different section is "wrong
        // section" (REJECT_CONTENT); source_id absent entirely is
        // "unresolved". Distinguishing these helps debugging.
        const anyKey = Array.from(idx.bySection.keys()).find(
            (k) => k.startsWith(`${ref.source_id}::`),
        );
        return { ok: false, reason: anyKey === undefined ? REJECT_UNRESOLVED : REJECT_CONTENT };
    }
    // Fast path: literal case-insensitive substring. If that misses,
    // fall back to a normalized substring (whitespace + punctuation
    // collapsed) before declaring REJECT_CONTENT. The synthesizer
    // legitimately paraphrases the snippet's quote — "Adults aged
    // 50–75" rendered as "adults 50 to 75 years" — and a literal
    // substring rejects it; the normalized path catches the most
    // common paraphrase shapes (whitespace drift, decorative
    // punctuation) without widening to a generic fuzzy match.
    const quoteOk =
        containsCI(snippet.quote, ref.quote)
        || containsCI(claim.text, snippet.quote)
        || containsNormalized(snippet.quote, ref.quote)
        || containsNormalized(claim.text, snippet.quote);
    if (!quoteOk) {
        return { ok: false, reason: REJECT_CONTENT };
    }
    return { ok: true, snippet };
};

/**
 * Compose the per-snippet confidence signal: parse the per-artifact
 * `confidence_signal` row if present, fall back to the snippet's own
 * `confidence` (the VLM's self-reported number the C.1 retriever
 * already projected) for the `selfReported` field. Returns `null`
 * when neither source carries any signal — the caller treats `null`
 * as low-confidence (architecture's fail-closed default).
 */
const composeConfidenceSignal = (
    snippet: ExtractedFactSnippet,
    ctx: VerifyContext,
): ConfidenceSignal | null => {
    const parsed = parseConfidenceSignal(ctx.artifactConfidence?.get(snippet.artifactId));
    if (parsed?.selfReported !== undefined) return parsed;
    if (snippet.confidence === undefined) return parsed;
    return {
        ...(parsed ?? { schemaWarningCount: 0, patientMatch: 'full' }),
        selfReported: snippet.confidence,
    };
};

/**
 * Pre-pass: detect intake-form low-confidence allergies and emit the
 * category-level fail-closed signal (architecture's allergy
 * exception). We piggyback on `HARD_STOP_ALLERGIES_UNAVAILABLE` —
 * the same shape the W1 chart-side rule already emits — so
 * `isStoppedCategory` and `format.ts`'s suppression policy treat
 * document-side and chart-side allergy gaps symmetrically.
 */
const computeAllergyExceptionStops = (
    ledger: ClaimLedger,
    extractedIdx: ExtractedDocIndex,
    ctx: VerifyContext,
): readonly HardStop[] => {
    for (const claim of ledger.claims) {
        if (claim.category !== 'allergy') continue;
        const ref = claim.sourceReferences[0];
        if (ref?.source_type !== 'extracted_document') continue;
        const fieldPath = ref.locator.field;
        if (fieldPath === undefined) continue;
        const snippet = extractedIdx.byKey.get(`${ref.source_id}::${fieldPath}`);
        if (snippet?.docType !== 'intake_form') continue;
        const signal = composeConfidenceSignal(snippet, ctx);
        if (signal === null || isLowConfidence(signal)) {
            return [HARD_STOP_ALLERGIES_UNAVAILABLE];
        }
    }
    return [];
};

export const verifyLedger = (
    snapshot: BriefingSnapshot,
    ledger: ClaimLedger,
    ctx: VerifyContext = {},
): VerifiedLedger => {
    const idx = buildSnapshotIndex(snapshot);
    const extractedIdx = buildExtractedDocIndex(ctx.documentEvidenceSnippets);
    const guidelineIdx = buildGuidelineIndex(ctx.evidenceRetrieverOutput);

    // Hard stops are the union of chart-side gaps (existing
    // computeHardStops) and document-side allergy fail-closed
    // (intake-form low-confidence allergy fact).
    const stops: HardStop[] = [
        ...computeHardStops(snapshot),
        ...computeAllergyExceptionStops(ledger, extractedIdx, ctx),
    ];

    const accepted: Claim[] = [];
    const rejected: { claim: Claim; reason: string }[] = [];

    for (const claim of ledger.claims) {
        if (claim.sourceReferences.length === 0) {
            rejected.push({ claim, reason: REJECT_NO_SOURCE });
            continue;
        }

        // §C.5 source_type dispatch. The first source ref's type
        // determines the resolution path — matches `format.ts`'s
        // primary-source-reference rule for sectioning. Mixed
        // source_type within one claim's refs is unusual; the chart
        // multi-ref strict-pass rule (every ref must resolve) is
        // applied within the chart branch, and extracted/guideline
        // claims are typically single-ref.
        const primary = claim.sourceReferences[0]!;

        // Recommendations are guideline-grounded by definition. A
        // chart-only "recommendation" is the failure mode this rule
        // is here to catch — a model that categorised a chart
        // observation as advice and tried to render it under
        // "Recommendations" without an authoritative source.
        if (claim.category === 'recommendation' && primary.source_type !== 'guideline') {
            rejected.push({ claim, reason: REJECT_RECOMMENDATION_NEEDS_GUIDELINE });
            continue;
        }

        if (primary.source_type === 'chart') {
            // Carry-forward W1 chart resolution path.
            if (isStoppedCategory(claim.category, stops)) {
                rejected.push({ claim, reason: REJECT_HARD_STOP });
                continue;
            }
            const check = CHECKS[claim.category];
            if (claim.category === 'lab') {
                // §4.2 strict-pass: every ref must resolve AND match.
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
            if (
                check.contentMatches !== undefined
                && !check.contentMatches(claim, resolvedRef, idx)
            ) {
                rejected.push({ claim, reason: REJECT_CONTENT });
                continue;
            }
            accepted.push(claim);
            continue;
        }

        if (primary.source_type === 'extracted_document') {
            const result = resolveExtractedDocument(primary, claim, extractedIdx);
            if (!result.ok) {
                rejected.push({ claim, reason: result.reason });
                continue;
            }
            // Confidence hard-stop runs AFTER source resolution and
            // BEFORE category fail-closed. Order matters: a claim
            // that fails resolution is a fabrication (different
            // engineering signal than a low-confidence-but-real
            // claim), and a claim suppressed by the allergy
            // exception belongs in the safety bucket regardless of
            // its individual confidence.
            const signal = composeConfidenceSignal(result.snippet, ctx);
            if (signal === null || isLowConfidence(signal)) {
                rejected.push({ claim, reason: REJECT_LOW_CONFIDENCE });
                continue;
            }
            if (isStoppedCategory(claim.category, stops)) {
                rejected.push({ claim, reason: REJECT_HARD_STOP });
                continue;
            }
            // Enrich the accepted claim's primary ref with the snippet's
            // documentUuid + extractorVersion. The synthesizer only emits
            // (artifactId, locator, quote); the panel's document drawer
            // and the format step's "From documents" grouping both need
            // `meta.document_uuid` to resolve the artifact back to its
            // source document.
            accepted.push(enrichExtractedDocClaim(claim, result.snippet));
            continue;
        }

        // primary.source_type === 'guideline'
        if (isStoppedCategory(claim.category, stops)) {
            rejected.push({ claim, reason: REJECT_HARD_STOP });
            continue;
        }
        const result = resolveGuideline(primary, claim, guidelineIdx);
        if (!result.ok) {
            rejected.push({ claim, reason: result.reason });
            continue;
        }
        // Enrich the accepted claim's primary ref with the snippet's
        // publication metadata. The agent-side schema receives these
        // slots; the panel reads them to render the guideline source
        // drawer (publication / section / quote / "view on publisher"
        // link). Without this enrichment the wire-side ref would carry
        // only the synthesizer's chunkId+section, and the panel would
        // have no way to surface the source URL.
        accepted.push(enrichGuidelineClaim(claim, result.snippet));
    }

    return {
        passed: rejected.length === 0 && stops.length === 0,
        accepted,
        rejected,
        safetyHardStops: stops,
    };
};
