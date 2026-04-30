import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type {
    Allergy,
    Diagnosis,
    Encounter,
    LabObservation,
    Medication,
    SourceReference,
} from '../../snapshot/types.js';
import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_MEDICATIONS_UNAVAILABLE,
} from '../../verify/verifier.js';
import type { Claim, FormattedBriefing, Gap, VerifiedLedger } from '../types.js';

/**
 * §3.2 + §3.3 implementation. Walks the snapshot + the verified ledger
 * and produces the structured `FormattedBriefing` the §3.4 SSE renderer
 * will emit. The shape mirrors USERS.md "Default Briefing Structure"
 * one-to-one so a future renderer can walk sections without parsing.
 *
 * §3.3 wired the verifier in. Format now honors two boundaries:
 *   1. it filters the medication section to records that appear in
 *      `verified.accepted` — claims dropped by the verifier never reach
 *      the UI as cited fact.
 *   2. it converts the medication section to a gap when the verifier
 *      reported a safety hard stop (`allergies-unavailable` or
 *      `medications-unavailable`), implementing "missing allergies →
 *      no medication summary shown" from the plan.
 *
 * Other sections (diagnoses, labs, encounters, allergies, appointment,
 * demographics) are walked from the snapshot directly because the
 * verifier's per-claim filter only narrows what was already there.
 * Future phases can promote them to claim-based filtering when there's
 * a real reason to.
 */

const isGap = (v: readonly unknown[] | Gap): v is Gap =>
    !Array.isArray(v) && (v as Gap).kind === 'gap';

const formatDiagnosis = (d: Diagnosis): { text: string; source: SourceReference } => ({
    text: `${d.code} (${d.codeSystem}) — ${d.label}`,
    source: d.source,
});

const formatMedication = (m: Medication): { text: string; source: SourceReference } => {
    const parts = [m.name];
    if (m.dose !== null) parts.push(m.dose);
    if (m.frequency !== null) parts.push(m.frequency);
    if (m.route !== null) parts.push(m.route);
    return { text: parts.join(' '), source: m.source };
};

const formatLab = (l: LabObservation): { text: string; source: SourceReference } => {
    const flag = l.abnormalFlag !== null && l.abnormalFlag !== '' ? ` [${l.abnormalFlag}]` : '';
    const unit = l.unit !== null ? ` ${l.unit}` : '';
    const date = l.observedAt !== null ? ` on ${l.observedAt}` : '';
    return { text: `${l.analyte}: ${l.value}${unit}${flag}${date}`, source: l.source };
};

const formatAllergy = (a: Allergy): { text: string; source: SourceReference } => {
    const reaction = a.reaction !== null ? ` (${a.reaction})` : '';
    return { text: `${a.substance}${reaction}`, source: a.source };
};

const formatEncounter = (e: Encounter): { text: string; source: SourceReference } => {
    const date = e.encounterDate ?? 'unknown date';
    const type = e.type ?? 'visit';
    const reason = e.reason !== null ? ` — ${e.reason}` : '';
    return { text: `${date}: ${type}${reason}`, source: e.source };
};

const medicationSection = (
    medications: readonly Medication[],
    verified: VerifiedLedger,
): readonly { text: string; source: SourceReference }[] | Gap => {
    if (verified.safetyHardStops.includes(HARD_STOP_MEDICATIONS_UNAVAILABLE)) {
        return {
            kind: 'gap',
            reason: HARD_STOP_MEDICATIONS_UNAVAILABLE,
            message: 'Medication data is unavailable.',
        };
    }
    if (verified.safetyHardStops.includes(HARD_STOP_ALLERGIES_UNAVAILABLE)) {
        return {
            kind: 'gap',
            reason: HARD_STOP_ALLERGIES_UNAVAILABLE,
            message: 'Allergy data is unavailable; medication summary withheld.',
        };
    }
    // Filter to medications that appear in at least one accepted claim's
    // source references. If the verifier ran on an empty ledger (e.g.
    // synthesizer is mocked out), pass through unchanged so the §3.2
    // happy-path tests that don't go through Synthesize still surface
    // medications. This is the only place the per-claim filter applies
    // today — other sections wait until a follow-up surfaces a real need.
    const acceptedRecordIds = collectAcceptedRecordIds(verified.accepted, 'medication');
    if (acceptedRecordIds === null) return medications.map(formatMedication);
    return medications
        .filter((m) => acceptedRecordIds.has(m.source.recordId))
        .map(formatMedication);
};

const collectAcceptedRecordIds = (
    accepted: readonly Claim[],
    category: Claim['category'],
): Set<string> | null => {
    const claimsForCategory = accepted.filter((c) => c.category === category);
    if (claimsForCategory.length === 0) return null;
    const ids = new Set<string>();
    for (const claim of claimsForCategory) {
        for (const ref of claim.sourceReferences) {
            ids.add(ref.recordId);
        }
    }
    return ids;
};

// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; stub body has no awaits yet.
export const format = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    if (state.verified === null) {
        throw new Error('Format called before Verify ran');
    }
    if (state.snapshot === null) {
        throw new Error('Format called without a snapshot');
    }
    const s = state.snapshot;
    const v = state.verified;

    const formatted: FormattedBriefing = {
        appointment: {
            text:
                s.appointment === null
                    ? 'No appointment in scope'
                    : `${s.appointment.startAt}: ${s.appointment.type ?? 'visit'}${
                          s.appointment.reason !== null ? ` — ${s.appointment.reason}` : ''
                      }`,
            source: s.appointment?.source ?? null,
        },
        demographics: {
            text: `${s.patient.displayName}${
                s.patient.dateOfBirth !== null ? ` (DOB ${s.patient.dateOfBirth})` : ''
            }${s.patient.sex !== null ? ` ${s.patient.sex}` : ''}`,
            source: s.patient.source,
        },
        activeDiagnoses: s.diagnoses.map(formatDiagnosis),
        currentMedications: medicationSection(s.medications, v),
        recentLabs: isGap(s.labs) ? s.labs : s.labs.map(formatLab),
        allergies: s.allergies.map(formatAllergy),
        recentEncounters: isGap(s.encounters) ? s.encounters : s.encounters.map(formatEncounter),
    };

    return { formatted };
};
