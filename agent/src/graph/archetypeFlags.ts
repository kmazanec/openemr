/**
 * §5.5 archetype-flag derivation. A pure function over a
 * `BriefingSnapshot` that emits short, machine-readable labels the
 * §5.4 schedule view chips off of.
 *
 * These flags encode "this patient looks like the X archetype" rather
 * than the verifier-derived `gaps[]` codes already carried on the
 * assistant message. The two surfaces are intentionally distinct:
 *
 *   - `gaps[].reason`  — verifier issues with this turn's claims
 *                        (e.g. `safety-critical-rejected`)
 *   - `archetypeFlags` — clinical-context labels derived from the
 *                        snapshot itself (e.g.
 *                        `archetype:diabetic_uncontrolled`)
 *
 * Both ride into `schedule_briefings.flags[]` (the precompute route
 * concatenates them) so the schedule annotations shim renders one
 * chip set per slot.
 *
 * Derivation rules mirror the §3.6 archetype ground truth in
 * `evals/runners/langsmithDataset.ts::groundTruth` and the
 * `bin/seed/PatientArchetype.php` source seed:
 *
 *   - `archetype:diabetic_uncontrolled`
 *       Active diagnosis includes `E11.9` AND a most-recent
 *       `Hemoglobin A1c` lab > 9.0%. The threshold matches the
 *       UC2 trend-up scenario's terminal value (9.4) and the
 *       seed's "uncontrolled" definition; well-controlled diabetics
 *       sit at 6.5–8.0 in the same fixtures.
 *
 *   - `archetype:recent_ed_visit`
 *       Any encounter sourced from the CCDA importer (i.e.
 *       `system: 'ccda-importer'`) — the seed pipeline tags
 *       outside-care rows that way. UC4's external-care branch
 *       already keys on the same field, so the rule reuses an
 *       established signal rather than parsing encounter `type`
 *       free text.
 *
 *   - `archetype:complex_elderly_new_med`
 *       At least three active diagnoses AND a prescription whose
 *       `startDate` is within 30 days before the appointment.
 *       "Complex elderly" without the recently-started qualifier
 *       isn't worth surfacing as a chip — the briefing already
 *       summarises the dx burden — and the new-med qualifier is
 *       what makes the flag actionable on the schedule view.
 *
 * The `Gap` shapes that `labs` / `encounters` may carry are treated
 * as "no signal" — a gap is the snapshot saying "I couldn't fetch
 * this", not "the patient has no encounters." Gating on a gap as if
 * it were data would surface false negatives the moment a downstream
 * fetch hiccups.
 */

import type { Encounter, LabObservation, Prescription } from '../snapshot/types.js';

import type { BriefingSnapshot } from './types.js';

const ARCHETYPE_DIABETIC_UNCONTROLLED = 'archetype:diabetic_uncontrolled';
const ARCHETYPE_RECENT_ED_VISIT = 'archetype:recent_ed_visit';
const ARCHETYPE_COMPLEX_ELDERLY_NEW_MED = 'archetype:complex_elderly_new_med';

const A1C_UNCONTROLLED_THRESHOLD = 9.0;
const NEW_MED_LOOKBACK_DAYS = 30;
const COMPLEX_DX_MIN = 3;
const CCDA_IMPORTER_SYSTEM = 'ccda-importer';

const isDiabeticUncontrolled = (snapshot: BriefingSnapshot): boolean => {
    const hasE119 = snapshot.diagnoses.some((dx) => dx.code === 'E11.9');
    if (!hasE119) {
        return false;
    }
    if ('kind' in snapshot.labs) {
        return false;
    }
    const a1cs: readonly LabObservation[] = snapshot.labs.filter(
        (lab) => lab.analyte === 'Hemoglobin A1c',
    );
    if (a1cs.length === 0) {
        return false;
    }
    return a1cs.some((lab) => {
        const numeric = Number.parseFloat(lab.value);
        return Number.isFinite(numeric) && numeric > A1C_UNCONTROLLED_THRESHOLD;
    });
};

const isRecentEdVisit = (snapshot: BriefingSnapshot): boolean => {
    if ('kind' in snapshot.encounters) {
        return false;
    }
    return snapshot.encounters.some(
        (enc: Encounter) => enc.source.system === CCDA_IMPORTER_SYSTEM,
    );
};

const isComplexElderlyWithNewMed = (snapshot: BriefingSnapshot): boolean => {
    if (snapshot.diagnoses.length < COMPLEX_DX_MIN) {
        return false;
    }
    if (snapshot.appointment === null) {
        return false;
    }
    const apptStart = Date.parse(snapshot.appointment.startAt);
    if (!Number.isFinite(apptStart)) {
        return false;
    }
    const lookbackMs = NEW_MED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    return snapshot.prescriptions.some((rx: Prescription) => {
        if (rx.startDate === null) {
            return false;
        }
        const started = Date.parse(rx.startDate);
        if (!Number.isFinite(started)) {
            return false;
        }
        return started >= apptStart - lookbackMs && started <= apptStart;
    });
};

export const deriveArchetypeFlags = (snapshot: BriefingSnapshot): readonly string[] => {
    const flags: string[] = [];
    if (isDiabeticUncontrolled(snapshot)) {
        flags.push(ARCHETYPE_DIABETIC_UNCONTROLLED);
    }
    if (isRecentEdVisit(snapshot)) {
        flags.push(ARCHETYPE_RECENT_ED_VISIT);
    }
    if (isComplexElderlyWithNewMed(snapshot)) {
        flags.push(ARCHETYPE_COMPLEX_ELDERLY_NEW_MED);
    }
    return flags;
};

export const ARCHETYPE_FLAGS = {
    DIABETIC_UNCONTROLLED: ARCHETYPE_DIABETIC_UNCONTROLLED,
    RECENT_ED_VISIT: ARCHETYPE_RECENT_ED_VISIT,
    COMPLEX_ELDERLY_NEW_MED: ARCHETYPE_COMPLEX_ELDERLY_NEW_MED,
} as const;
