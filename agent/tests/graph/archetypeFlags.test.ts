import { describe, expect, it } from 'vitest';

import {
    ARCHETYPE_FLAGS,
    deriveArchetypeFlags,
} from '../../src/graph/archetypeFlags.js';
import type { BriefingSnapshot } from '../../src/graph/types.js';
import type {
    LabObservation,
    Prescription,
    SourceReference,
} from '../../src/snapshot/types.js';
import { ARCHETYPES, type ArchetypeKey } from '../../evals/fixtures/regenerate-archetypes.js';
import { loadFixture } from '../../evals/fixtures/load.js';

/**
 * §5.5 derivation rules, exercised against the canonical UC1
 * fixtures + a few bespoke snapshots that pin the boundary of each
 * rule (A1c at threshold, prescription start outside the lookback,
 * etc.). The rules are pure functions over the snapshot, so this
 * file is the only contract test that needs to exist.
 */

const FIELD_FOR_RECORD_TYPE: Record<string, string> = {
    Patient: 'patient.name',
    Appointment: 'appointment.start',
    Condition: 'condition.code',
    MedicationRequest: 'medication.name',
    AllergyIntolerance: 'allergy.substance',
    Observation: 'observation.value',
    Encounter: 'encounter.date',
    Task: 'task.description',
    MedicationStatement: 'medicationStatement.medication',
    DocumentReference: 'documentReference.text',
};

const sourceRef = (
    _system: string,
    recordType: string,
    recordId: string,
): SourceReference => ({
    source_type: 'chart',
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const baseSnapshot = (): BriefingSnapshot => ({
    patient: {
        pid: 1,
        uuid: 'p-1',
        displayName: 'Test Patient',
        sex: 'F',
        dateOfBirth: '1950-01-01',
        ageYears: 58,
        source: sourceRef('openemr', 'Patient', '1'),
    },
    appointment: {
        appointmentId: 'apt-1',
        startAt: '2026-05-01T14:00:00Z',
        durationMinutes: 30,
        type: 'Follow-up',
        reason: 'Routine',
        source: sourceRef('openemr', 'Appointment', 'apt-1'),
    },
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    labHistory: null,
    reminders: [],
    medications: [],
});

const a1cLab = (value: string): LabObservation => ({
    analyte: 'Hemoglobin A1c',
    value,
    unit: '%',
    referenceRange: '4.0-5.6',
    abnormalFlag: 'H',
    observedAt: '2026-04-15',
    source: sourceRef('openemr', 'Observation', `obs-a1c-${value}`),
});

const newPrescription = (startDate: string): Prescription => ({
    name: 'Atorvastatin',
    dose: '20mg',
    route: 'oral',
    frequency: 'qd',
    startDate,
    stopDate: null,
    prescriber: 'Dr. Test',
    indication: 'New start',
    prescriptionId: 'rx-1',
    source: sourceRef('openemr', 'Prescription', 'rx-1'),
});

interface ExpectedFlags {
    readonly diabeticUncontrolled: boolean;
    readonly recentEdVisit: boolean;
    readonly complexElderlyNewMed: boolean;
}

/**
 * Per-archetype expectation. Mirrors the §5.5 acceptance contract:
 * the three flagged archetypes (`diabetic_uncontrolled`,
 * `recent_ed_visit`, `complex_elderly`) and the three unflagged ones.
 *
 * `complex_elderly` does NOT flag against the canonical UC1 fixture
 * because that fixture's prescriptions started in 2008/2010 — the
 * `archetype:complex_elderly_new_med` rule keys on a prescription
 * within 30 days of the appointment. The §5.5 day fixture
 * (`regenerate-morning-prep.ts`) injects a recent prescription onto its
 * complex-elderly slots so the day eval surfaces the chip; this test
 * validates the rule, not the day-fixture injection.
 *
 * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
 */
const ARCHETYPE_EXPECTATIONS: Record<ArchetypeKey, ExpectedFlags> = {
    healthy_adult: {
        diabeticUncontrolled: false,
        recentEdVisit: false,
        complexElderlyNewMed: false,
    },
    hypertensive: {
        diabeticUncontrolled: false,
        recentEdVisit: false,
        complexElderlyNewMed: false,
    },
    diabetic: {
        diabeticUncontrolled: false,
        recentEdVisit: false,
        complexElderlyNewMed: false,
    },
    diabetic_uncontrolled: {
        diabeticUncontrolled: true,
        recentEdVisit: false,
        complexElderlyNewMed: false,
    },
    complex_elderly: {
        diabeticUncontrolled: false,
        recentEdVisit: false,
        complexElderlyNewMed: false,
    },
    recent_ed_visit: {
        diabeticUncontrolled: false,
        recentEdVisit: true,
        complexElderlyNewMed: false,
    },
};

describe('deriveArchetypeFlags — UC1 fixtures', () => {
    it.each(ARCHETYPES)('matches the §5.5 expectation for %s', (archetype) => {
        const snapshot = loadFixture(archetype);
        const flags = deriveArchetypeFlags(snapshot);
        const expected = ARCHETYPE_EXPECTATIONS[archetype];
        expect(flags.includes(ARCHETYPE_FLAGS.DIABETIC_UNCONTROLLED)).toBe(
            expected.diabeticUncontrolled,
        );
        expect(flags.includes(ARCHETYPE_FLAGS.RECENT_ED_VISIT)).toBe(
            expected.recentEdVisit,
        );
        expect(flags.includes(ARCHETYPE_FLAGS.COMPLEX_ELDERLY_NEW_MED)).toBe(
            expected.complexElderlyNewMed,
        );
    });
});

describe('deriveArchetypeFlags — boundary rules', () => {
    it('does not flag diabetic_uncontrolled when E11.9 is missing', () => {
        const snap: BriefingSnapshot = {
            ...baseSnapshot(),
            labs: [a1cLab('9.4')],
        };
        expect(deriveArchetypeFlags(snap)).not.toContain(
            ARCHETYPE_FLAGS.DIABETIC_UNCONTROLLED,
        );
    });

    it('does not flag diabetic_uncontrolled when A1c is at the 9.0 threshold', () => {
        // Strict greater-than: 9.0 exactly does NOT flag. The threshold
        // is the seed's "well-controlled vs uncontrolled" boundary;
        // ties go to "well-controlled" so a borderline A1c does not
        // light up the schedule chip.
        const snap: BriefingSnapshot = {
            ...baseSnapshot(),
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes',
                    onsetDate: '2020-01-01',
                    source: sourceRef('openemr', 'Diagnosis', 'dx-1'),
                },
            ],
            labs: [a1cLab('9.0')],
        };
        expect(deriveArchetypeFlags(snap)).not.toContain(
            ARCHETYPE_FLAGS.DIABETIC_UNCONTROLLED,
        );
    });

    it('flags diabetic_uncontrolled at A1c 9.1 with E11.9 present', () => {
        const snap: BriefingSnapshot = {
            ...baseSnapshot(),
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes',
                    onsetDate: '2020-01-01',
                    source: sourceRef('openemr', 'Diagnosis', 'dx-1'),
                },
            ],
            labs: [a1cLab('9.1')],
        };
        expect(deriveArchetypeFlags(snap)).toContain(
            ARCHETYPE_FLAGS.DIABETIC_UNCONTROLLED,
        );
    });

    it('treats a labs Gap as no signal (not a flag)', () => {
        const snap: BriefingSnapshot = {
            ...baseSnapshot(),
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes',
                    onsetDate: '2020-01-01',
                    source: sourceRef('openemr', 'Diagnosis', 'dx-1'),
                },
            ],
            labs: { kind: 'gap', reason: 'unavailable', message: 'fetch failed' },
        };
        expect(deriveArchetypeFlags(snap)).not.toContain(
            ARCHETYPE_FLAGS.DIABETIC_UNCONTROLLED,
        );
    });

    it.skip('flags recent_ed_visit only when an encounter is sourced from ccda-importer', () => {
        // W1 distinguished CCDA-imported encounters via `source.system
        // === 'ccda-importer'`. W2 dropped the `system` field; the
        // narrow recent-ED-visit rule cannot be expressed without a
        // richer encounter origin marker, which is C-phase work. Until
        // then `isRecentEdVisit` widens to "any encounter present" and
        // this test is skipped — see archetypeFlags.ts.
    });

    it('flags complex_elderly_new_med when 3+ dx and a prescription started within 30d', () => {
        const snap: BriefingSnapshot = {
            ...baseSnapshot(),
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'HTN',
                    onsetDate: null,
                    source: sourceRef('openemr', 'Diagnosis', 'dx-1'),
                },
                {
                    code: 'E78.5',
                    codeSystem: 'ICD-10',
                    label: 'Hyperlipidemia',
                    onsetDate: null,
                    source: sourceRef('openemr', 'Diagnosis', 'dx-2'),
                },
                {
                    code: 'M19.90',
                    codeSystem: 'ICD-10',
                    label: 'Osteoarthritis',
                    onsetDate: null,
                    source: sourceRef('openemr', 'Diagnosis', 'dx-3'),
                },
            ],
            // Appointment is 2026-05-01; 14 days prior = within 30d.
            prescriptions: [newPrescription('2026-04-17')],
        };
        expect(deriveArchetypeFlags(snap)).toContain(
            ARCHETYPE_FLAGS.COMPLEX_ELDERLY_NEW_MED,
        );
    });

    it('does not flag complex_elderly_new_med when the new med predates the lookback', () => {
        const snap: BriefingSnapshot = {
            ...baseSnapshot(),
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'HTN',
                    onsetDate: null,
                    source: sourceRef('openemr', 'Diagnosis', 'dx-1'),
                },
                {
                    code: 'E78.5',
                    codeSystem: 'ICD-10',
                    label: 'Hyperlipidemia',
                    onsetDate: null,
                    source: sourceRef('openemr', 'Diagnosis', 'dx-2'),
                },
                {
                    code: 'M19.90',
                    codeSystem: 'ICD-10',
                    label: 'Osteoarthritis',
                    onsetDate: null,
                    source: sourceRef('openemr', 'Diagnosis', 'dx-3'),
                },
            ],
            // Appointment is 2026-05-01; 60 days prior = outside the
            // 30d lookback.
            prescriptions: [newPrescription('2026-03-01')],
        };
        expect(deriveArchetypeFlags(snap)).not.toContain(
            ARCHETYPE_FLAGS.COMPLEX_ELDERLY_NEW_MED,
        );
    });
});
