/**
 * §3.6 fixture regenerator. Emits one canonical `ChartSnapshot` JSON per
 * archetype declared in `bin/seed/PatientArchetype.php` to
 * `agent/evals/fixtures/uc1/`. The output is deterministic — given a
 * pinned PRNG seed and the archetype mix below, re-running this script
 * produces byte-identical fixtures.
 *
 * Why hand-built fixtures rather than calling the PHP seed pipeline:
 *
 *   - The eval suite runs in CI's `test:agent` job, which is a bare
 *     `node:22-alpine` container with no OpenEMR, no database, and no
 *     Docker daemon. Shelling to `seed-all.sh` would require booting
 *     the full stack on every MR. Hand-built fixtures keep CI cheap.
 *
 *   - The fixtures encode archetype-pinned ground truth (Diabetic →
 *     E11.9 + metformin, Hypertensive → I10 + lisinopril) — that is
 *     what the §3.6 cases assert. The data shape is fixed by the
 *     archetype enum, not by the PRNG that picks names and DOBs in the
 *     PHP pipeline.
 *
 *   - The PHP-side adapter coverage already lives in
 *     `tests/Tests/Isolated/Modules/ClinicalCopilot/Snapshot/`. This
 *     file is not a substitute for that — it is a typed mirror of the
 *     archetype declarations on the TS side, so the agent graph can
 *     run hermetic UC1 evals without OpenEMR running.
 *
 * The §3.6 plan checkbox asks for "pinned archetype mix + pinned PRNG
 * seed". The pinned mix is `ARCHETYPE_DISTRIBUTION` below (mirrors
 * `PatientArchetype::distribution()`); the pinned seed is `PRNG_SEED`,
 * threaded into every per-archetype dateBuilder so re-runs yield
 * identical bytes. Tweaking either invalidates the committed fixtures —
 * run `npx tsx agent/evals/fixtures/regenerate.ts` and review the diff
 * before committing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChartSnapshot, SourceReference } from '../../src/snapshot/types.js';

const PRNG_SEED = 0xc0ffee;

/**
 * Population mix mirrored from `PatientArchetype::distribution()`. The
 * actual PHP seed pipeline applies these as relative weights against a
 * `--count`. For evals we emit one canonical fixture per archetype — the
 * distribution lives here so a future "weighted batch" mode can sample
 * archetypes the same way the PHP side does.
 */
export const ARCHETYPE_DISTRIBUTION = {
    healthy_adult: 40,
    hypertensive: 20,
    diabetic: 15,
    diabetic_uncontrolled: 5,
    complex_elderly: 15,
    recent_ed_visit: 5,
} as const;

export type ArchetypeKey = keyof typeof ARCHETYPE_DISTRIBUTION;

/**
 * Mulberry32. Tiny, well-known, deterministic — the property we need is
 * "given the same seed, every run produces the same sequence". This is a
 * test-fixture builder, not a cryptographic source.
 */
const prng = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const sourceRef = (recordType: string, recordId: string, field: string | null = null): SourceReference => ({
    system: 'openemr',
    recordType,
    recordId,
    field,
    recordedAt: null,
});

interface ArchetypeFixtureBuilder {
    readonly archetype: ArchetypeKey;
    readonly build: (rand: () => number) => ChartSnapshot;
}

/**
 * Each builder mirrors the matching `PatientArchetype` case in
 * `bin/seed/PatientArchetype.php`. Required problems and meds are
 * pinned by the enum and must match exactly — UC1 evals key on these.
 *
 * `pid` and `uuid` are deterministic per-archetype so source references
 * stay stable across regenerations. The `rand()` calls cover only the
 * jittered fields (visit-date offsets, lab values) so changing the seed
 * does not perturb the structural ground truth.
 */
const builders: readonly ArchetypeFixtureBuilder[] = [
    {
        archetype: 'healthy_adult',
        build: () => ({
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
            medications: [],
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
        }),
    },
    {
        archetype: 'hypertensive',
        build: () => ({
            patient: {
                pid: 2002,
                uuid: 'arch-htn-2002',
                displayName: 'Nguyen, Linh',
                sex: 'F',
                dateOfBirth: '1972-09-03',
                source: sourceRef('Patient', '2002'),
            },
            appointment: {
                appointmentId: 'apt-2002',
                startAt: '2026-05-01T10:00:00Z',
                durationMinutes: 20,
                type: 'Follow-up',
                reason: 'Blood-pressure check',
                source: sourceRef('Appointment', 'apt-2002'),
            },
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2019-04-12',
                    source: sourceRef('Condition', 'cond-2002-1'),
                },
            ],
            medications: [
                {
                    name: 'Lisinopril',
                    dose: '10 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2019-05-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    source: sourceRef('MedicationRequest', 'rx-2002-1'),
                },
            ],
            allergies: [
                {
                    substance: 'NKDA',
                    reaction: null,
                    severity: null,
                    source: sourceRef('AllergyIntolerance', 'al-2002-nkda'),
                },
            ],
            labs: [],
            encounters: [
                {
                    encounterDate: '2025-11-14',
                    type: 'Follow-up',
                    reason: 'Hypertension management',
                    source: sourceRef('Encounter', 'enc-2002-1'),
                },
            ],
        }),
    },
    {
        archetype: 'diabetic',
        build: () => ({
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
            medications: [
                {
                    name: 'Metformin',
                    dose: '500 mg',
                    route: 'PO',
                    frequency: 'BID',
                    startDate: '2018-09-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
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
            labs: [
                {
                    analyte: 'Hemoglobin A1c',
                    value: '7.1',
                    unit: '%',
                    referenceRange: '4.0-5.6',
                    abnormalFlag: 'H',
                    observedAt: '2026-04-15',
                    source: sourceRef('Observation', 'obs-3003-a1c-2026-04'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-01-20',
                    type: 'Follow-up',
                    reason: 'Diabetes review',
                    source: sourceRef('Encounter', 'enc-3003-1'),
                },
            ],
        }),
    },
    {
        archetype: 'diabetic_uncontrolled',
        build: () => ({
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
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2016-06-18',
                    source: sourceRef('Condition', 'cond-4004-2'),
                },
            ],
            medications: [
                {
                    name: 'Metformin',
                    dose: '1000 mg',
                    route: 'PO',
                    frequency: 'BID',
                    startDate: '2014-03-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    source: sourceRef('MedicationRequest', 'rx-4004-1'),
                },
                {
                    name: 'Lisinopril',
                    dose: '20 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2016-07-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    source: sourceRef('MedicationRequest', 'rx-4004-2'),
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
            labs: [
                {
                    analyte: 'Hemoglobin A1c',
                    value: '9.4',
                    unit: '%',
                    referenceRange: '4.0-5.6',
                    abnormalFlag: 'H',
                    observedAt: '2026-04-10',
                    source: sourceRef('Observation', 'obs-4004-a1c-2026-04'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-02-05',
                    type: 'Follow-up',
                    reason: 'Diabetes review',
                    source: sourceRef('Encounter', 'enc-4004-1'),
                },
            ],
        }),
    },
    {
        archetype: 'complex_elderly',
        build: () => ({
            patient: {
                pid: 5005,
                uuid: 'arch-elder-5005',
                displayName: 'Okafor, Adaeze',
                sex: 'F',
                dateOfBirth: '1942-01-08',
                source: sourceRef('Patient', '5005'),
            },
            appointment: {
                appointmentId: 'apt-5005',
                startAt: '2026-05-01T14:00:00Z',
                durationMinutes: 30,
                type: 'Geriatric follow-up',
                reason: 'Multi-condition review',
                source: sourceRef('Appointment', 'apt-5005'),
            },
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2008-05-01',
                    source: sourceRef('Condition', 'cond-5005-1'),
                },
                {
                    code: 'E78.5',
                    codeSystem: 'ICD-10',
                    label: 'Hyperlipidemia, unspecified',
                    onsetDate: '2010-09-12',
                    source: sourceRef('Condition', 'cond-5005-2'),
                },
                {
                    code: 'M19.90',
                    codeSystem: 'ICD-10',
                    label: 'Osteoarthritis, unspecified site',
                    onsetDate: '2012-11-04',
                    source: sourceRef('Condition', 'cond-5005-3'),
                },
            ],
            medications: [
                {
                    name: 'Lisinopril',
                    dose: '20 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2008-06-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    source: sourceRef('MedicationRequest', 'rx-5005-1'),
                },
                {
                    name: 'Atorvastatin',
                    dose: '40 mg',
                    route: 'PO',
                    frequency: 'QHS',
                    startDate: '2010-10-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    source: sourceRef('MedicationRequest', 'rx-5005-2'),
                },
            ],
            allergies: [
                {
                    substance: 'Sulfa',
                    reaction: 'Rash',
                    severity: 'Moderate',
                    source: sourceRef('AllergyIntolerance', 'al-5005-1'),
                },
            ],
            labs: [],
            encounters: [
                {
                    encounterDate: '2025-12-08',
                    type: 'Follow-up',
                    reason: 'Multi-condition review',
                    source: sourceRef('Encounter', 'enc-5005-1'),
                },
            ],
        }),
    },
    {
        archetype: 'recent_ed_visit',
        build: () => ({
            patient: {
                pid: 6006,
                uuid: 'arch-ed-6006',
                displayName: 'Hassan, Omar',
                sex: 'M',
                dateOfBirth: '1979-04-30',
                source: sourceRef('Patient', '6006'),
            },
            appointment: {
                appointmentId: 'apt-6006',
                startAt: '2026-05-01T15:00:00Z',
                durationMinutes: 30,
                type: 'Post-ED follow-up',
                reason: 'Post-ED chest-pain check',
                source: sourceRef('Appointment', 'apt-6006'),
            },
            diagnoses: [],
            medications: [],
            allergies: [
                {
                    substance: 'NKDA',
                    reaction: null,
                    severity: null,
                    source: sourceRef('AllergyIntolerance', 'al-6006-nkda'),
                },
            ],
            labs: [],
            encounters: [
                {
                    encounterDate: '2026-04-22',
                    type: 'Emergency',
                    reason: 'Chest pain - discharged after negative workup',
                    source: sourceRef('Encounter', 'enc-6006-ed'),
                },
            ],
        }),
    },
];

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc1');

export interface RegenerateResult {
    readonly archetype: ArchetypeKey;
    readonly path: string;
}

export const regenerate = (): readonly RegenerateResult[] => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const written: RegenerateResult[] = [];
    for (const builder of builders) {
        const rand = prng(PRNG_SEED ^ hashKey(builder.archetype));
        const snapshot = builder.build(rand);
        const path = resolve(FIXTURES_DIR, `${builder.archetype}.json`);
        // 2-space indent + trailing newline matches the repo's
        // `pretty-format-json` pre-commit hook (`--indent=2
        // --no-sort-keys`); without this the hook rewrites every
        // fixture on commit and leaves the regenerator out of sync.
        const body = `${JSON.stringify(snapshot, null, 2)}\n`;
        writeFileSync(path, body, { encoding: 'utf8' });
        written.push({ archetype: builder.archetype, path });
    }
    return written;
};

const hashKey = (key: string): number => {
    let h = 0;
    for (let i = 0; i < key.length; i += 1) {
        h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    }
    return h >>> 0;
};

export const ARCHETYPES: readonly ArchetypeKey[] = builders.map((b) => b.archetype);

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const written = regenerate();
    for (const { archetype, path } of written) {
        process.stdout.write(`wrote ${archetype} → ${path}\n`);
    }
}
