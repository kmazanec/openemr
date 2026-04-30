import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type {
    Allergy,
    Diagnosis,
    Encounter,
    LabObservation,
    Medication,
    SourceReference,
} from '../../snapshot/types.js';
import type { FormattedBriefing, Gap } from '../types.js';

/**
 * §3.2 implementation. Walks the snapshot + the verified ledger and
 * produces the structured `FormattedBriefing` the §3.4 SSE renderer
 * will emit. The shape mirrors USERS.md "Default Briefing Structure"
 * one-to-one so a future renderer can walk sections without parsing.
 *
 * Format consumes the snapshot directly today because §3.2's `Verify`
 * stub passes claims through unchanged. Once §3.3 lands the
 * verification gate, this node should switch to building section text
 * from `state.verified.accepted` so unverified claims never reach the
 * UI. The function signature already takes `verified` so the swap is
 * small.
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

// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; stub body has no awaits yet.
export const format = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    if (state.verified === null) {
        throw new Error('Format called before Verify ran');
    }
    if (state.snapshot === null) {
        throw new Error('Format called without a snapshot');
    }
    const s = state.snapshot;

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
        currentMedications: s.medications.map(formatMedication),
        recentLabs: isGap(s.labs) ? s.labs : s.labs.map(formatLab),
        allergies: s.allergies.map(formatAllergy),
        recentEncounters: isGap(s.encounters) ? s.encounters : s.encounters.map(formatEncounter),
    };

    return { formatted };
};
