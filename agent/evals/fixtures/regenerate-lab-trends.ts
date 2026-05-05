/**
 * §4.2 UC2 lab-trend fixture regenerator.
 *
 * Mirrors the §3.6 `regenerate.ts` shape but emits one
 * `BriefingSnapshot` per UC2 scenario instead of per archetype:
 *
 *   - `a1c_trend_up.json`     Diabetic-Uncontrolled archetype, four
 *                              A1c values rising 7.2 → 8.1 → 8.7 → 9.4
 *   - `a1c_trend_stable.json` Diabetic archetype, four A1c values
 *                              hovering in the 6.9–7.2 band
 *   - `no_lab_history.json`   Healthy-Adult archetype, zero history
 *                              rows (drives the verifier's "no trend
 *                              when count < 2" path)
 *
 * Scenario-shaped fixtures (rather than archetype-shaped) because UC2
 * branches on the lab-history shape, not on the patient archetype:
 * the same Diabetic archetype could surface either trend depending on
 * which labs the lab system has on file.
 *
 * The patient + diagnoses + medications fields mirror the
 * corresponding UC1 archetype fixtures so cross-references stay
 * stable between UC1 and UC2 cases (§A.5 contract: a `pid` always
 * resolves to the same demographics on this fixture set).
 *
 * Output uses 2-space indent + trailing newline + ASCII-only — same
 * format as the §3.6 fixtures so the repo's `pretty-format-json`
 * pre-commit hook doesn't rewrite the files on commit.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BriefingSnapshot } from '../../src/graph/types.js';
import type { LabObservation, SourceReference } from '../../src/snapshot/types.js';

/**
 * UC2 fixtures pin patient identity to the matching UC1 archetype, so
 * `ageYears` is computed against the same reference date the UC1
 * regenerator uses (`2026-05-01`). Mirror inline to keep regenerators
 * zero-dependency.
 */
const FIXTURE_AS_OF_DATE = '2026-05-01';

const ageYearsAt = (dateOfBirth: string, asOf = FIXTURE_AS_OF_DATE): number => {
    const [by, bm, bd] = dateOfBirth.split('-').map((s) => Number.parseInt(s, 10));
    const [ay, am, ad] = asOf.split('-').map((s) => Number.parseInt(s, 10));
    if (
        by === undefined ||
        bm === undefined ||
        bd === undefined ||
        ay === undefined ||
        am === undefined ||
        ad === undefined
    ) {
        throw new Error(`ageYearsAt: bad date input ${dateOfBirth} or ${asOf}`);
    }
    let age = ay - by;
    if (am < bm || (am === bm && ad < bd)) {
        age -= 1;
    }
    return age;
};

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
    recordType: string,
    recordId: string,
    field: string | null = null,
): SourceReference => ({
    source_type: 'chart',
    source_id: recordId,
    locator: { field: field ?? FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const obs = (
    recordId: string,
    value: string,
    observedAt: string,
): LabObservation => ({
    analyte: 'Hemoglobin A1c',
    value,
    unit: '%',
    referenceRange: '4.0-5.6',
    abnormalFlag: 'H',
    observedAt,
    source: sourceRef('Observation', recordId),
});

type Uc2ScenarioLiteral = 'a1c_trend_up' | 'a1c_trend_stable' | 'no_lab_history';

interface Uc2Fixture {
    readonly name: Uc2ScenarioLiteral;
    readonly snapshot: BriefingSnapshot;
}

const trendUp: Uc2Fixture = {
    name: 'a1c_trend_up',
    snapshot: {
        // Same identity as UC1 `diabetic_uncontrolled.json`. Cross-UC
        // continuity: clicking "Trend A1c" from a UC1 briefing for
        // pid 4004 lands here.
        patient: {
            pid: 4004,
            uuid: 'arch-dm-unc-4004',
            displayName: 'Carter, Marcus',
            sex: 'M',
            dateOfBirth: '1960-11-20',
            ageYears: ageYearsAt('1960-11-20'),
            source: sourceRef('Patient', '4004'),
        },
        appointment: {
            appointmentId: 'apt-4004',
            startAt: '2026-05-01T13:00:00Z',
            durationMinutes: 40,
            type: 'Diabetes follow-up',
            reason: 'Uncontrolled A1c review',
            source: sourceRef('Appointment', 'apt-4004'),
        },
        diagnoses: [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes mellitus without complications',
                onsetDate: '2014-02-10',
                source: sourceRef('Condition', 'cond-4004-1'),
            },
        ],
        prescriptions: [
            {
                name: 'Metformin',
                dose: '1000 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2014-03-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Type 2 diabetes mellitus',
                prescriptionId: '40041',
                source: sourceRef('MedicationRequest', 'rx-4004-1'),
            },
        ],
        allergies: [
            {
                substance: 'NKDA',
                reaction: null,
                severity: null,
                source: sourceRef('AllergyIntolerance', 'al-4004-nkda'),
            },
        ],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-02-05',
                type: 'Follow-up',
                reason: 'Diabetes review',
                source: sourceRef('Encounter', 'enc-4004-1'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: {
            analyte: 'Hemoglobin A1c',
            observations: [
                obs('obs-4004-a1c-2024-04', '7.2', '2024-04-15'),
                obs('obs-4004-a1c-2025-04', '8.1', '2025-04-15'),
                obs('obs-4004-a1c-2025-10', '8.7', '2025-10-15'),
                obs('obs-4004-a1c-2026-04', '9.4', '2026-04-15'),
            ],
        },
    },
};

const trendStable: Uc2Fixture = {
    name: 'a1c_trend_stable',
    snapshot: {
        // Same identity as UC1 `diabetic.json`.
        patient: {
            pid: 3003,
            uuid: 'arch-dm-3003',
            displayName: 'Patel, Maya',
            sex: 'F',
            dateOfBirth: '1958-03-15',
            ageYears: ageYearsAt('1958-03-15'),
            source: sourceRef('Patient', '3003'),
        },
        appointment: {
            appointmentId: 'apt-3003',
            startAt: '2026-05-01T11:00:00Z',
            durationMinutes: 30,
            type: 'Diabetes follow-up',
            reason: 'Quarterly diabetes review',
            source: sourceRef('Appointment', 'apt-3003'),
        },
        diagnoses: [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes mellitus without complications',
                onsetDate: '2018-08-22',
                source: sourceRef('Condition', 'cond-3003-1'),
            },
        ],
        prescriptions: [
            {
                name: 'Metformin',
                dose: '500 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2018-09-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Type 2 diabetes mellitus',
                prescriptionId: '30031',
                source: sourceRef('MedicationRequest', 'rx-3003-1'),
            },
        ],
        allergies: [
            {
                substance: 'Penicillin',
                reaction: 'Hives',
                severity: 'Moderate',
                source: sourceRef('AllergyIntolerance', 'al-3003-1'),
            },
        ],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-01-20',
                type: 'Follow-up',
                reason: 'Diabetes review',
                source: sourceRef('Encounter', 'enc-3003-1'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: {
            analyte: 'Hemoglobin A1c',
            observations: [
                obs('obs-3003-a1c-2024-10', '7.0', '2024-10-15'),
                obs('obs-3003-a1c-2025-04', '7.1', '2025-04-15'),
                obs('obs-3003-a1c-2025-10', '6.9', '2025-10-15'),
                obs('obs-3003-a1c-2026-04', '7.2', '2026-04-15'),
            ],
        },
    },
};

const noHistory: Uc2Fixture = {
    name: 'no_lab_history',
    snapshot: {
        // Same identity as UC1 `healthy_adult.json`.
        patient: {
            pid: 1001,
            uuid: 'arch-healthy-1001',
            displayName: 'Reyes, Jordan',
            sex: 'M',
            dateOfBirth: '1988-06-12',
            ageYears: ageYearsAt('1988-06-12'),
            source: sourceRef('Patient', '1001'),
        },
        appointment: {
            appointmentId: 'apt-1001',
            startAt: '2026-05-01T09:00:00Z',
            durationMinutes: 30,
            type: 'Annual physical',
            reason: 'Routine annual visit',
            source: sourceRef('Appointment', 'apt-1001'),
        },
        diagnoses: [],
        prescriptions: [],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2025-05-04',
                type: 'Annual physical',
                reason: 'Routine annual visit',
                source: sourceRef('Encounter', 'enc-1001-1'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: {
            analyte: 'Hemoglobin A1c',
            observations: [],
        },
    },
};

const fixtures: readonly Uc2Fixture[] = [trendUp, trendStable, noHistory];

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'lab-trends');

export interface RegenerateLabTrendResult {
    readonly name: string;
    readonly path: string;
}

/**
 * Coerce id fields from string (decoder shape) to JSON number (wire
 * shape). The bulk-snapshot endpoint ships `prescriptionId` /
 * `reminderId` as JSON numbers; the TS DTO holds them as strings for
 * uniformity with `source.recordId`. Mirrors the same coercion in
 * `regenerate.ts::toWireFormat`.
 */
const toWireFormat = (snapshot: BriefingSnapshot): unknown => {
    const prescriptions = snapshot.prescriptions.map((p) => ({
        ...p,
        prescriptionId: p.prescriptionId === null ? null : Number.parseInt(p.prescriptionId, 10),
    }));
    const remindersIn = snapshot.reminders;
    const reminders = 'kind' in remindersIn
        ? remindersIn
        : remindersIn.map((r) => ({
            ...r,
            reminderId: r.reminderId === null ? null : Number.parseInt(r.reminderId, 10),
        }));
    const medsIn = snapshot.medications;
    const medications = 'kind' in medsIn
        ? medsIn
        : medsIn.map((m) => ({
            ...m,
            listId: m.listId === null ? null : Number.parseInt(m.listId, 10),
        }));
    return { ...snapshot, prescriptions, reminders, medications };
};

export const regenerate = (): readonly RegenerateLabTrendResult[] => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const written: RegenerateLabTrendResult[] = [];
    for (const fixture of fixtures) {
        const path = resolve(FIXTURES_DIR, `${fixture.name}.json`);
        // 2-space indent + trailing newline matches the repo's
        // `pretty-format-json` pre-commit hook (`--indent=2
        // --no-sort-keys`); without this the hook rewrites every
        // fixture on commit and leaves the regenerator out of sync.
        const body = `${JSON.stringify(toWireFormat(fixture.snapshot), null, 2)}\n`;
        writeFileSync(path, body, { encoding: 'utf8' });
        written.push({ name: fixture.name, path });
    }
    return written;
};

export type LabTrendScenarioName = (typeof fixtures)[number]['name'];

export const LAB_TREND_SCENARIOS: readonly LabTrendScenarioName[] = fixtures.map((f) => f.name);

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const written = regenerate();
    for (const { name, path } of written) {
        process.stdout.write(`wrote ${name} → ${path}\n`);
    }
}
