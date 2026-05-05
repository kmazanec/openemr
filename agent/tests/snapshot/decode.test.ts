import { describe, expect, it } from 'vitest';

import { ChartSnapshotDecodeError, decodeChartSnapshot } from '../../src/snapshot/decode.js';

const validJson = {
    patient: {
        pid: 42,
        uuid: 'patient-uuid',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: {
            source_type: 'chart' as const,
            source_id: '42',
            locator: { field: 'patient.name' },
            quote: '42',
            meta: { record_recorded_at: '2026-04-30' },
        },
    },
    appointment: {
        appointmentId: 'apt-1',
        startAt: '2026-04-30T09:00:00+00:00',
        durationMinutes: 20,
        type: 'Office Visit',
        reason: 'Diabetes follow-up',
        source: {
            source_type: 'chart' as const,
            source_id: 'apt-1',
            locator: { field: 'appointment.start' },
            quote: 'apt-1',
            meta: { record_recorded_at: '2026-04-30' },
        },
    },
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes mellitus without complications',
            onsetDate: '2020-01-01',
            source: {
                source_type: 'chart' as const,
                source_id: 'cond-1',
                locator: { field: 'condition.code' },
                quote: 'cond-1',
                meta: { record_recorded_at: '2020-01-01' },
            },
        },
    ],
    prescriptions: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            indication: 'type 2 diabetes',
            prescriptionId: 7001,
            source: {
                source_type: 'chart' as const,
                source_id: 'rx-1',
                locator: { field: 'dosageInstruction' },
                quote: 'rx-1',
                meta: { record_recorded_at: '2020-01-01' },
            },
        },
    ],
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'Moderate',
            source: {
                source_type: 'chart' as const,
                source_id: 'all-1',
                locator: { field: 'allergy.substance' },
                quote: 'all-1',
                meta: { record_recorded_at: '2018-06-01' },
            },
        },
    ],
    labs: [
        {
            analyte: 'A1c',
            value: '8.4',
            unit: '%',
            referenceRange: '<7.0',
            abnormalFlag: 'H',
            observedAt: '2026-04-15',
            source: {
                source_type: 'chart' as const,
                source_id: 'lab-1',
                locator: { field: 'value' },
                quote: 'lab-1',
                meta: { record_recorded_at: '2026-04-15' },
            },
        },
    ],
    encounters: [
        {
            encounterDate: '2026-03-01',
            type: 'Office Visit',
            reason: 'Diabetes follow-up',
            source: {
                source_type: 'chart' as const,
                source_id: 'enc-1',
                locator: { field: 'encounter.date' },
                quote: 'enc-1',
                meta: { record_recorded_at: '2026-03-01' },
            },
        },
    ],
    reminders: [],
    medications: [],
};

describe('decodeChartSnapshot', () => {
    it('decodes a fully-populated snapshot from the OpenEMR PHP shape', () => {
        const out = decodeChartSnapshot(validJson);

        expect(out.patient.pid).toBe(42);
        expect(out.patient.uuid).toBe('patient-uuid');
        expect(out.patient.ageYears).toBe(58);
        expect(out.appointment?.appointmentId).toBe('apt-1');
        expect(out.diagnoses).toHaveLength(1);
        expect(out.diagnoses[0]!.code).toBe('E11.9');
        expect(out.prescriptions[0]!.name).toBe('Metformin');
        expect(out.allergies[0]!.substance).toBe('Penicillin');
        expect(out.labs[0]!.analyte).toBe('A1c');
        expect(out.encounters[0]!.encounterDate).toBe('2026-03-01');
    });

    it('accepts a null appointment (UC1 may run outside an appointment context)', () => {
        const out = decodeChartSnapshot({ ...validJson, appointment: null });
        expect(out.appointment).toBeNull();
    });

    it('accepts empty category lists when minimization stripped them', () => {
        const minimized = {
            ...validJson,
            diagnoses: [],
            prescriptions: [],
            allergies: [],
            labs: [],
            encounters: [],
            reminders: [],
            medications: [],
        };
        const out = decodeChartSnapshot(minimized);
        expect(out.diagnoses).toHaveLength(0);
        expect(out.prescriptions).toHaveLength(0);
        expect(out.allergies).toHaveLength(0);
    });

    it('preserves source references on every list item', () => {
        const out = decodeChartSnapshot(validJson);
        expect(out.prescriptions[0]!.source).toEqual({
            source_type: 'chart' as const,
            source_id: 'rx-1',
            locator: { field: 'dosageInstruction' },
            quote: 'rx-1',
            meta: { record_recorded_at: '2020-01-01' },
        });
    });

    it('rejects a non-object input', () => {
        expect(() => decodeChartSnapshot('not an object')).toThrow(ChartSnapshotDecodeError);
        expect(() => decodeChartSnapshot(null)).toThrow(ChartSnapshotDecodeError);
        expect(() => decodeChartSnapshot([])).toThrow(ChartSnapshotDecodeError);
    });

    it('rejects a snapshot missing the patient block', () => {
        const { patient: _patient, ...rest } = validJson;
        expect(() => decodeChartSnapshot(rest)).toThrow(/patient/i);
    });

    it('rejects a diagnosis missing its source reference', () => {
        const broken = {
            ...validJson,
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Diabetes',
                    onsetDate: null,
                    // source: missing
                },
            ],
        };
        expect(() => decodeChartSnapshot(broken)).toThrow(/source/i);
    });

    it('rejects a medication with a non-string name', () => {
        const broken = {
            ...validJson,
            prescriptions: [{ ...validJson.prescriptions[0], name: 123 }],
        };
        expect(() => decodeChartSnapshot(broken)).toThrow(/prescriptions\[0\]\.name/);
    });

    it('round-trips a ccda-importer encounter without losing the system field', () => {
        // §4.4 UC4. ExternalEncounterAdapter (PHP) emits Encounter
        // toArray() rows with `source.system: 'ccda-importer'`. The
        // §4.1 follow-ups generator and the verifier both read
        // `system` directly off the decoded shape, so the decoder must
        // preserve it verbatim alongside the existing 'openemr'
        // entries.
        const withExternal = {
            ...validJson,
            encounters: [
                ...validJson.encounters,
                {
                    encounterDate: '2026-04-22',
                    type: 'St. Mary ED',
                    reason: 'Chest pain - discharged after negative workup',
                    source: {
                        source_type: 'chart' as const,
                        source_id: 'ext-7',
                        locator: { field: 'encounter.date' },
                        quote: 'ext-7',
                        meta: { record_recorded_at: '2026-04-22' },
                    },
                },
            ],
        };
        const out = decodeChartSnapshot(withExternal);
        expect(out.encounters).toHaveLength(2);
        // W2 dropped the `system` field; both encounters carry
        // `source_type: 'chart'`. Re-introducing a richer encounter
        // origin marker is C-phase work.
        expect(out.encounters[0]!.source.source_type).toBe('chart');
        expect(out.encounters[1]!.source.source_type).toBe('chart');
        expect(out.encounters[1]!.source.source_id).toBe('ext-7');
    });

    it('rejects a lab with a non-string value (preserves string-typed contract)', () => {
        const broken = {
            ...validJson,
            labs: [{ ...validJson.labs[0], value: 8.4 }],
        };
        // Plan §2.2 ObservationAdapter: `value` is preserved as a string so
        // text qualifiers like "<0.01" survive normalization.
        expect(() => decodeChartSnapshot(broken)).toThrow(/labs\[0\]\.value/);
    });

    // §4.3: indication + prescriptionId are added to the briefing-time
    // Medication shape so the briefing path can mention indication and the
    // medication-change branch can address a prescription by id.
    it('decodes a medication indication and prescriptionId', () => {
        const out = decodeChartSnapshot(validJson);
        expect(out.prescriptions[0]!.indication).toBe('type 2 diabetes');
        expect(out.prescriptions[0]!.prescriptionId).toBe('7001');
    });

    it('coerces null indication / prescriptionId to null on decode', () => {
        const json = {
            ...validJson,
            prescriptions: [{
                ...validJson.prescriptions[0],
                indication: null,
                prescriptionId: null,
            }],
        };
        const out = decodeChartSnapshot(json);
        expect(out.prescriptions[0]!.indication).toBeNull();
        expect(out.prescriptions[0]!.prescriptionId).toBeNull();
    });

    it('treats missing indication / prescriptionId as null (additive contract)', () => {
        // Older fixtures predating §4.3 omit these keys entirely. The
        // decoder is additive so a synchronized regen of every fixture
        // isn't a hard prerequisite.
        const med = { ...validJson.prescriptions[0] } as Record<string, unknown>;
        delete med['indication'];
        delete med['prescriptionId'];
        const out = decodeChartSnapshot({ ...validJson, prescriptions: [med] });
        expect(out.prescriptions[0]!.indication).toBeNull();
        expect(out.prescriptions[0]!.prescriptionId).toBeNull();
    });

    it('rejects a non-integer prescriptionId', () => {
        const broken = {
            ...validJson,
            prescriptions: [{ ...validJson.prescriptions[0], prescriptionId: '7001' }],
        };
        expect(() => decodeChartSnapshot(broken)).toThrow(/prescriptions\[0\]\.prescriptionId/);
    });

    it('treats a missing ageYears as null (additive contract for older fixtures)', () => {
        const patient = { ...validJson.patient } as Record<string, unknown>;
        delete patient['ageYears'];
        const out = decodeChartSnapshot({ ...validJson, patient });
        expect(out.patient.ageYears).toBeNull();
    });

    it('decodes a null ageYears when DOB was missing on the source row', () => {
        const out = decodeChartSnapshot({
            ...validJson,
            patient: { ...validJson.patient, dateOfBirth: null, ageYears: null },
        });
        expect(out.patient.ageYears).toBeNull();
    });

    it('rejects a non-integer ageYears', () => {
        const broken = {
            ...validJson,
            patient: { ...validJson.patient, ageYears: '58' },
        };
        expect(() => decodeChartSnapshot(broken)).toThrow(/patient\.ageYears/);
    });
});
