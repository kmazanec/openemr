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
 * Reference "today" used to compute `ageYears` for fixture builders.
 * Pinned to match the appointment day the agent fixtures already use
 * (`apt-3003.startAt = 2026-05-01T11:00:00Z` etc.), so the carried
 * age aligns with the visit context the model sees in eval runs.
 *
 * Production code computes age from `new DateTimeImmutable('today')`
 * inside `PatientAdapter`; this constant is the eval-fixture analogue.
 * Bumping the eval reference date means `npm run evals:regenerate-*`
 * and reviewing the diff.
 */
const FIXTURE_AS_OF_DATE = '2026-05-01';

/**
 * Whole-year age between an ISO `YYYY-MM-DD` DOB and `FIXTURE_AS_OF_DATE`.
 * Mirrors the production `Normalize::ageYears` PHP helper. Inline
 * because `regenerate*.ts` files are zero-dependency by design.
 */
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

const sourceRef = (
    recordType: string,
    recordId: string,
    field: string | null = null,
    system = 'openemr',
): SourceReference => ({
    system,
    recordType,
    recordId,
    field,
    recordedAt: null,
});

/**
 * §3.6 builders were originally keyed by `ArchetypeKey` (entries of the
 * UC1 distribution map). §4.3 added per-UC fixtures —
 * `lisinopril_recent_start`, `med_no_indication`,
 * `med_unknown_prescriber` — that the UC3 cases load by name without
 * polluting the UC1 sampling distribution. The builder key widens to
 * `string` so those names are accepted; UC1's archetype set is still
 * filtered out of `ARCHETYPES` below for the §3.6 sampler.
 */
interface ArchetypeFixtureBuilder {
    readonly archetype: string;
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
                ageYears: ageYearsAt('1972-09-03'),
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
            prescriptions: [
                {
                    name: 'Lisinopril',
                    dose: '10 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2019-05-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'Essential (primary) hypertension',
                    prescriptionId: '22001',
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
            reminders: [],
            medications: [],
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
                    prescriptionId: '33001',
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
            reminders: [],
            medications: [],
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
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2016-06-18',
                    source: sourceRef('Condition', 'cond-4004-2'),
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
                    prescriptionId: '44001',
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
                    indication: 'Essential (primary) hypertension',
                    prescriptionId: '44002',
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
            // Phase 4.6.3: uncontrolled diabetes implies a tighter
            // recall — the briefing should surface the A1c follow-up
            // due so the clinician can confirm or reschedule.
            reminders: [
                {
                    item: 'a1c_recheck',
                    itemTitle: 'A1c follow-up',
                    category: 'lab_followup',
                    categoryTitle: 'Lab follow-up',
                    dueStatus: 'due',
                    createdAt: '2026-04-01',
                    reminderId: '85002',
                    source: sourceRef('Task', '85002'),
                },
            ],
            medications: [],
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
                ageYears: ageYearsAt('1942-01-08'),
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
            prescriptions: [
                {
                    name: 'Lisinopril',
                    dose: '20 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2008-06-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'Essential (primary) hypertension',
                    prescriptionId: '55001',
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
                    indication: 'Hyperlipidemia',
                    prescriptionId: '55002',
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
            // Phase 4.6.3: complex_elderly is the canonical
            // "fell-off-the-screening-schedule" patient — overdue
            // mammogram is the briefing's highest-value reminder
            // surface for this archetype.
            reminders: [
                {
                    item: 'mammogram',
                    itemTitle: 'Mammogram screening',
                    category: 'screening',
                    categoryTitle: 'Screening',
                    dueStatus: 'overdue',
                    createdAt: '2025-11-01',
                    reminderId: '85001',
                    source: sourceRef('Task', '85001'),
                },
            ],
            // Phase 4.6.4: complex_elderly is the canonical
            // patient-reported medication case — chronic pain managed
            // with OTC Tylenol the patient bought on their own. The
            // briefing surfaces this so a clinician sees the full
            // medication picture, not just clinic-written scripts.
            medications: [
                {
                    name: 'Tylenol',
                    dose: '500 mg as needed',
                    usageCategory: 'OTC',
                    informationSource: 'Patient',
                    startDate: '2024-06-01',
                    stopDate: null,
                    listId: '95001',
                    source: sourceRef('MedicationStatement', '95001'),
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
                ageYears: ageYearsAt('1979-04-30'),
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
            prescriptions: [],
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
                // §4.4 UC4. The ED visit is imported via CCDA, so its
                // SourceReference carries `system: 'ccda-importer'`
                // (matching what the PHP-side ExternalEncounterAdapter
                // emits from the `external_encounters` table). The
                // §4.1 follow-ups generator looks at this exact field
                // to decide whether to surface the `external_care`
                // suggestion.
                {
                    encounterDate: '2026-04-22',
                    type: 'Emergency',
                    reason: 'Chest pain - discharged after negative workup',
                    source: sourceRef('Encounter', 'enc-6006-ed', null, 'ccda-importer'),
                },
            ],
            reminders: [],
            medications: [],
        }),
    },
    // -----------------------------------------------------------------
    // §4.3 UC3 — three per-MR Vitest fixtures for the medication-change
    // drill-down. Lisinopril startDate is pinned 42 days before the
    // 2026-05-01 reference date (matches USERS.md UC3 "started 6 weeks
    // ago"). Distinct pids and rxids so a USERS.md-shaped patient-list
    // test could mix them with UC1's mix without collision.
    // -----------------------------------------------------------------
    {
        archetype: 'lisinopril_recent_start',
        build: () => ({
            patient: {
                pid: 7001,
                uuid: 'arch-uc3-7001',
                displayName: 'Patel, Maya',
                sex: 'F',
                dateOfBirth: '1958-03-15',
                ageYears: ageYearsAt('1958-03-15'),
                source: sourceRef('Patient', '7001'),
            },
            appointment: {
                appointmentId: 'apt-7001',
                startAt: '2026-05-01T11:00:00Z',
                durationMinutes: 30,
                type: 'Diabetes follow-up',
                reason: 'Quarterly diabetes review + new lisinopril check-in',
                source: sourceRef('Appointment', 'apt-7001'),
            },
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes mellitus without complications',
                    onsetDate: '2018-08-22',
                    source: sourceRef('Condition', 'cond-7001-1'),
                },
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2026-03-15',
                    source: sourceRef('Condition', 'cond-7001-2'),
                },
            ],
            prescriptions: [
                {
                    name: 'Metformin',
                    dose: '1000 mg',
                    route: 'PO',
                    frequency: 'BID',
                    startDate: '2018-09-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'Type 2 diabetes mellitus',
                    prescriptionId: '77001',
                    source: sourceRef('MedicationRequest', '77001'),
                },
                {
                    // Started 42 days before the appointment (USERS.md UC3).
                    name: 'Lisinopril',
                    dose: '10 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2026-03-20',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'new-onset hypertension',
                    prescriptionId: '77002',
                    source: sourceRef('MedicationRequest', '77002'),
                },
            ],
            allergies: [
                {
                    substance: 'NKDA',
                    reaction: null,
                    severity: null,
                    source: sourceRef('AllergyIntolerance', 'al-7001-nkda'),
                },
            ],
            labs: [],
            encounters: [
                {
                    encounterDate: '2026-03-20',
                    type: 'Office Visit',
                    reason: 'New-onset hypertension; lisinopril started',
                    source: sourceRef('Encounter', 'enc-7001-1'),
                },
            ],
            reminders: [],
            medications: [],
        }),
    },
    {
        archetype: 'med_no_indication',
        build: () => ({
            patient: {
                pid: 7002,
                uuid: 'arch-uc3-7002',
                displayName: 'Tran, Bao',
                sex: 'M',
                dateOfBirth: '1965-07-22',
                ageYears: ageYearsAt('1965-07-22'),
                source: sourceRef('Patient', '7002'),
            },
            appointment: {
                appointmentId: 'apt-7002',
                startAt: '2026-05-01T11:30:00Z',
                durationMinutes: 20,
                type: 'Follow-up',
                reason: 'Medication review',
                source: sourceRef('Appointment', 'apt-7002'),
            },
            diagnoses: [],
            prescriptions: [
                {
                    name: 'Lisinopril',
                    dose: '10 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2026-03-20',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    // Source row has no documented indication. UC3
                    // verifier rule: claim text must omit indication too.
                    indication: null,
                    prescriptionId: '77201',
                    source: sourceRef('MedicationRequest', '77201'),
                },
            ],
            allergies: [
                {
                    substance: 'NKDA',
                    reaction: null,
                    severity: null,
                    source: sourceRef('AllergyIntolerance', 'al-7002-nkda'),
                },
            ],
            labs: [],
            encounters: [],
            reminders: [],
            medications: [],
        }),
    },
    {
        archetype: 'med_unknown_prescriber',
        build: () => ({
            patient: {
                pid: 7003,
                uuid: 'arch-uc3-7003',
                displayName: 'Lopez, Ana',
                sex: 'F',
                dateOfBirth: '1970-12-04',
                ageYears: ageYearsAt('1970-12-04'),
                source: sourceRef('Patient', '7003'),
            },
            appointment: {
                appointmentId: 'apt-7003',
                startAt: '2026-05-01T12:00:00Z',
                durationMinutes: 20,
                type: 'Follow-up',
                reason: 'Medication review',
                source: sourceRef('Appointment', 'apt-7003'),
            },
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2026-03-15',
                    source: sourceRef('Condition', 'cond-7003-1'),
                },
            ],
            prescriptions: [
                {
                    name: 'Lisinopril',
                    dose: '10 mg',
                    route: 'PO',
                    frequency: 'QD',
                    startDate: '2026-03-20',
                    stopDate: null,
                    // Source row has no documented prescriber (e.g. an
                    // imported Rx whose provider didn't resolve to a
                    // user). Verifier rule: claim text must omit
                    // prescriber rather than fabricate one.
                    prescriber: null,
                    indication: 'new-onset hypertension',
                    prescriptionId: '77301',
                    source: sourceRef('MedicationRequest', '77301'),
                },
            ],
            allergies: [
                {
                    substance: 'NKDA',
                    reaction: null,
                    severity: null,
                    source: sourceRef('AllergyIntolerance', 'al-7003-nkda'),
                },
            ],
            labs: [],
            encounters: [],
            reminders: [],
            medications: [],
        }),
    },
];

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc1');

export interface RegenerateResult {
    readonly archetype: string;
    readonly path: string;
}

/**
 * The PHP-side `Medication::toArray()` emits `prescriptionId` as a JSON
 * integer (mirroring the underlying DB primary key); the TS-side
 * `Medication.prescriptionId` is `string | null` (because every other
 * id in the snapshot shape is a string). Builders work with the
 * decoded shape (string), and the writer coerces back to the wire
 * format on the way to disk so `decodeChartSnapshot` accepts the
 * regenerated fixtures unchanged.
 */
const toWireFormat = (snapshot: ChartSnapshot): unknown => ({
    ...snapshot,
    prescriptions: snapshot.prescriptions.map((m) => ({
        ...m,
        prescriptionId: m.prescriptionId === null ? null : Number.parseInt(m.prescriptionId, 10),
    })),
    reminders: snapshot.reminders.map((r) => ({
        ...r,
        reminderId: r.reminderId === null ? null : Number.parseInt(r.reminderId, 10),
    })),
    medications: snapshot.medications.map((m) => ({
        ...m,
        listId: m.listId === null ? null : Number.parseInt(m.listId, 10),
    })),
});

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
        const body = `${JSON.stringify(toWireFormat(snapshot), null, 2)}\n`;
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

/**
 * UC1's archetype keys, used by the §3.6 archetypes test. Excludes the
 * §4.3 UC3-specific fixtures so a future weighted-sampler doesn't pick
 * them in a UC1 batch.
 */
export const ARCHETYPES: readonly ArchetypeKey[] =
    builders
        .map((b) => b.archetype)
        .filter((k): k is ArchetypeKey => k in ARCHETYPE_DISTRIBUTION);

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const written = regenerate();
    for (const { archetype, path } of written) {
        process.stdout.write(`wrote ${archetype} → ${path}\n`);
    }
}
