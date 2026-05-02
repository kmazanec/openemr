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

const sourceRef = (
    recordType: string,
    recordId: string,
    field: string | null = null,
): SourceReference => ({
    system: 'openemr',
    recordType,
    recordId,
    field,
    recordedAt: null,
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
        labHistory: {
            analyte: 'Hemoglobin A1c',
            observations: [],
        },
    },
};

const fixtures: readonly Uc2Fixture[] = [trendUp, trendStable, noHistory];

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc2');

export interface RegenerateUc2Result {
    readonly name: string;
    readonly path: string;
}

export const regenerateUc2 = (): readonly RegenerateUc2Result[] => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const written: RegenerateUc2Result[] = [];
    for (const fixture of fixtures) {
        const path = resolve(FIXTURES_DIR, `${fixture.name}.json`);
        // 2-space indent + trailing newline matches the repo's
        // `pretty-format-json` pre-commit hook (`--indent=2
        // --no-sort-keys`); without this the hook rewrites every
        // fixture on commit and leaves the regenerator out of sync.
        const body = `${JSON.stringify(fixture.snapshot, null, 2)}\n`;
        writeFileSync(path, body, { encoding: 'utf8' });
        written.push({ name: fixture.name, path });
    }
    return written;
};

export type Uc2ScenarioName = (typeof fixtures)[number]['name'];

export const UC2_SCENARIOS: readonly Uc2ScenarioName[] = fixtures.map((f) => f.name);

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const written = regenerateUc2();
    for (const { name, path } of written) {
        process.stdout.write(`wrote ${name} → ${path}\n`);
    }
}
