/**
 * Judgment-mixed case set.
 *
 * Ten realistic clinic scenarios in three groups, all driven through
 * the conversational graph as `task: 'follow_up'`. The set is the
 * dataset substrate for the judgment-rubric suite — the deterministic
 * gate (verifier accept/reject, hard-stop) is what the per-MR Vitest
 * cases assert; the LangSmith experiment scores the actual prose
 * against the LLM-as-judge rubrics.
 *
 * Group 1 (4 cases) — multi-retriever. Each fixture seeds an
 * extracted-document artifact AND the question naturally requires a
 * guideline lookup, so the supervisor must invoke both
 * `documentEvidenceRetriever` and `evidenceRetriever` in the same
 * turn. Mirrors the `multi-retriever` pattern in
 * `conversationalGraphTarget.ts` but covers four distinct clinical
 * archetypes (T2DM intensification, statin primary prevention, dense-
 * breast screening, BP third-agent guidance).
 *
 * Group 2 (4 cases) — chart-only. No artifacts. The question is
 * answerable directly from the snapshot, so the supervisor should
 * route to `synthesize` without invoking either retriever. This
 * exercises the "trivial chart Q&A" surface that production sees on
 * most turns.
 *
 * Group 3 (2 cases) — redaction. Preserves the structural-redaction
 * coverage from the deleted end-to-end suite:
 *   - `redact-cross-patient-artifact`: an artifact whose `pid` does
 *     not match the envelope's patient is excluded by
 *     `searchArtifacts`'s pid-scope filter, so the synthesizer never
 *     sees cross-patient data. The model answers a benign chart-only
 *     question normally.
 *   - `redact-hidden-off-schema-ssn`: an intake artifact whose
 *     `schemaJson` carries a known field PLUS an off-schema
 *     `ssn` field. The retriever's known-field projection
 *     drops the SSN before snippets reach the synthesizer, so the
 *     accepted ledger never contains an SSN-pattern match. The
 *     verifier doesn't need to reject anything — the redaction
 *     is structural, upstream of synthesis.
 *
 * Patient pids and uuids are distinct per case (`4501..4510` /
 * `p-cg-0501..p-cg-0510`) so a single multi-case experiment run
 * cannot accidentally mix snapshots between scenarios.
 */

import type { BriefingSnapshot, RequestEnvelope } from '../../../src/graph/types.js';
import type { ExtractionArtifact } from '../../../src/state/extractionArtifacts.js';

import type { CaseSpec, ScenarioFixture } from './_types.js';

export type JudgmentMixedCaseId =
    // multi-retriever (need both extracted doc AND guideline)
    | 'mixed-hba1c-plus-ada-intensification'
    | 'mixed-ldl-plus-statin-recommendation'
    | 'mixed-mammogram-density-plus-screening'
    | 'mixed-bp-plus-second-agent-guidance'
    // chart-only
    | 'chart-medication-list-summary'
    | 'chart-last-encounter-recap'
    | 'chart-active-allergies-check'
    | 'chart-active-diagnoses-list'
    // redaction (preserve end-to-end behavioral coverage)
    | 'redact-cross-patient-artifact'
    | 'redact-hidden-off-schema-ssn';

export type { ScenarioFixture, CaseSpec } from './_types.js';

const ACTOR = {
    userId: 'experiment',
    fhirUser: 'https://emr/Practitioner/experiment',
} as const;

const chartSrc = (sourceId: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

const buildEnvelope = (
    caseId: JudgmentMixedCaseId,
    pid: number,
    uuid: string,
    question: string,
): RequestEnvelope => ({
    conversationId: `cg-${caseId}`,
    requestId: `cg-${caseId}-req-1`,
    siteId: 'default',
    actor: ACTOR,
    patient: { pid, uuid },
    task: 'follow_up',
    question,
});

// ---------------------------------------------------------------------
// Group 1: multi-retriever fixtures (extracted document + guideline)
// ---------------------------------------------------------------------

const hba1cFixture = (): ScenarioFixture => {
    const pid = 4501;
    const uuid = 'p-cg-0501';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Patel, Maya',
            sex: 'F',
            dateOfBirth: '1968-03-15',
            ageYears: 58,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes without complications',
                onsetDate: '2020-01-01',
                source: chartSrc('dx-t2dm-1', 'condition.code'),
            },
        ],
        prescriptions: [
            {
                name: 'Metformin 500 mg',
                dose: '500 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2020-01-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Type 2 diabetes',
                prescriptionId: 'rx-met-1',
                source: chartSrc('rx-met-1', 'medication.name'),
            },
        ],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-04-01',
                type: 'office_visit',
                reason: 'Diabetes follow-up',
                source: chartSrc('enc-1', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0501-1111-2222-3333-444444444444',
        documentUuid: 'doc-cg-lab-0501',
        pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'HbA1c',
                    value: 8.4,
                    unit: '%',
                    page: 1,
                    bbox: [40, 200, 380, 220],
                    quote: 'HbA1c 8.4 %',
                    confidence: 0.95,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.95, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: 'a'.repeat(64),
        createdAt: '2026-05-04T12:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'mixed-hba1c-plus-ada-intensification',
            pid,
            uuid,
            "Her HbA1c is 8.4 on the new lab — what's the guideline say about timing of metformin titration or adding a second agent?",
        ),
        artifacts: [artifact],
    };
};

const ldlFixture = (): ScenarioFixture => {
    const pid = 4502;
    const uuid = 'p-cg-0502';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Reyes, Luis',
            sex: 'M',
            dateOfBirth: '1967-08-22',
            ageYears: 58,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential (primary) hypertension',
                onsetDate: '2018-06-01',
                source: chartSrc('dx-htn-1', 'condition.code'),
            },
        ],
        prescriptions: [
            {
                name: 'Lisinopril 20 mg',
                dose: '20 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2018-06-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-lis-1',
                source: chartSrc('rx-lis-1', 'medication.name'),
            },
        ],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-03-12',
                type: 'office_visit',
                reason: 'BP check',
                source: chartSrc('enc-2', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0502-1111-2222-3333-444444444444',
        documentUuid: 'doc-cg-lab-0502',
        pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'LDL cholesterol',
                    value: 178,
                    unit: 'mg/dL',
                    page: 1,
                    bbox: [40, 240, 380, 260],
                    quote: 'LDL 178 mg/dL',
                    confidence: 0.93,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.93, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: 'b'.repeat(64),
        createdAt: '2026-05-04T13:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'mixed-ldl-plus-statin-recommendation',
            pid,
            uuid,
            'His LDL on the new lipid panel is 178 — given his HTN, what does the prevention guideline say about statin initiation?',
        ),
        artifacts: [artifact],
    };
};

const mammogramFixture = (): ScenarioFixture => {
    const pid = 4503;
    const uuid = 'p-cg-0503';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Okafor, Adaeze',
            sex: 'F',
            dateOfBirth: '1973-11-04',
            ageYears: 52,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [],
        prescriptions: [],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-04-18',
                type: 'office_visit',
                reason: 'Annual physical',
                source: chartSrc('enc-3', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0503-1111-2222-3333-444444444444',
        documentUuid: 'doc-cg-mammo-0503',
        pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'Mammogram BIRADS',
                    value: 'BIRADS-2',
                    unit: null,
                    page: 1,
                    bbox: [60, 180, 360, 200],
                    quote: 'Assessment: BIRADS-2 (benign finding)',
                    confidence: 0.92,
                },
                {
                    analyte: 'Breast density',
                    value: 'heterogeneously dense',
                    unit: null,
                    page: 1,
                    bbox: [60, 220, 360, 240],
                    quote: 'Density: heterogeneously dense',
                    confidence: 0.9,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.91, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: 'c'.repeat(64),
        createdAt: '2026-05-04T14:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'mixed-mammogram-density-plus-screening',
            pid,
            uuid,
            "Her mammogram came back BIRADS-2 but with dense breasts — what's the guideline-recommended approach to screening with dense breasts?",
        ),
        artifacts: [artifact],
    };
};

const bpFixture = (): ScenarioFixture => {
    const pid = 4504;
    const uuid = 'p-cg-0504';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Nguyen, Tran',
            sex: 'M',
            dateOfBirth: '1961-02-19',
            ageYears: 64,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential (primary) hypertension',
                onsetDate: '2015-09-01',
                source: chartSrc('dx-htn-2', 'condition.code'),
            },
        ],
        prescriptions: [
            {
                name: 'Lisinopril 20 mg',
                dose: '20 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2015-09-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-lis-2',
                source: chartSrc('rx-lis-2', 'medication.name'),
            },
            {
                name: 'Amlodipine 5 mg',
                dose: '5 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2023-01-10',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-aml-1',
                source: chartSrc('rx-aml-1', 'medication.name'),
            },
        ],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-03-30',
                type: 'office_visit',
                reason: 'BP follow-up',
                source: chartSrc('enc-4', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0504-1111-2222-3333-444444444444',
        documentUuid: 'doc-cg-bplog-0504',
        pid,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            symptoms: [
                {
                    value: 'Home BP readings 152-160/92-98 over 14 days',
                    page: 1,
                    bbox: [50, 260, 400, 290],
                    quote: 'Home BP log: systolic 152-160, diastolic 92-98 (past 2 weeks)',
                    confidence: 0.88,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.88, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: 'd'.repeat(64),
        createdAt: '2026-05-04T15:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'mixed-bp-plus-second-agent-guidance',
            pid,
            uuid,
            'His home BP log shows 152-160/92-98 on his current regimen — what does the guideline recommend as a third agent?',
        ),
        artifacts: [artifact],
    };
};

// ---------------------------------------------------------------------
// Group 2: chart-only fixtures (no artifacts, no guideline)
// ---------------------------------------------------------------------

const medicationListFixture = (): ScenarioFixture => {
    const pid = 4505;
    const uuid = 'p-cg-0505';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Hernandez, Carmen',
            sex: 'F',
            dateOfBirth: '1954-07-30',
            ageYears: 71,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [],
        prescriptions: [
            {
                name: 'Warfarin 5 mg',
                dose: '5 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2022-04-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Atrial fibrillation',
                prescriptionId: 'rx-wf-1',
                source: chartSrc('rx-wf-1', 'medication.name'),
            },
            {
                name: 'Metoprolol 25 mg',
                dose: '25 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2022-04-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Rate control',
                prescriptionId: 'rx-mt-1',
                source: chartSrc('rx-mt-1', 'medication.name'),
            },
            {
                name: 'Atorvastatin 40 mg',
                dose: '40 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2021-02-10',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hyperlipidemia',
                prescriptionId: 'rx-at-1',
                source: chartSrc('rx-at-1', 'medication.name'),
            },
            {
                name: 'Omeprazole 20 mg',
                dose: '20 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2023-08-22',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'GERD',
                prescriptionId: 'rx-om-1',
                source: chartSrc('rx-om-1', 'medication.name'),
            },
        ],
        allergies: [],
        labs: [],
        encounters: [],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'chart-medication-list-summary',
            pid,
            uuid,
            'Quick — what meds is she currently on?',
        ),
        artifacts: [],
    };
};

const lastEncounterFixture = (): ScenarioFixture => {
    const pid = 4506;
    const uuid = 'p-cg-0506';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Schmidt, Greta',
            sex: 'F',
            dateOfBirth: '1969-05-12',
            ageYears: 56,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [],
        prescriptions: [],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-04-22',
                type: 'office_visit',
                reason: 'Annual physical',
                source: chartSrc('enc-5', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'chart-last-encounter-recap',
            pid,
            uuid,
            'What was her last visit for, and when was it?',
        ),
        artifacts: [],
    };
};

const allergiesFixture = (): ScenarioFixture => {
    const pid = 4507;
    const uuid = 'p-cg-0507';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Park, Jiwoo',
            sex: 'M',
            dateOfBirth: '1977-10-08',
            ageYears: 48,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [],
        prescriptions: [],
        allergies: [
            {
                substance: 'Penicillin',
                reaction: 'hives',
                severity: 'moderate',
                source: chartSrc('al-pen-1', 'allergy.substance'),
            },
            {
                substance: 'Latex',
                reaction: 'contact dermatitis',
                severity: 'mild',
                source: chartSrc('al-ltx-1', 'allergy.substance'),
            },
        ],
        labs: [],
        encounters: [],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'chart-active-allergies-check',
            pid,
            uuid,
            'Any allergies I should be aware of before I write this prescription?',
        ),
        artifacts: [],
    };
};

const diagnosesFixture = (): ScenarioFixture => {
    const pid = 4508;
    const uuid = 'p-cg-0508';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Brown, Marcus',
            sex: 'M',
            dateOfBirth: '1963-12-01',
            ageYears: 62,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes without complications',
                onsetDate: '2014-05-01',
                source: chartSrc('dx-t2dm-2', 'condition.code'),
            },
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential (primary) hypertension',
                onsetDate: '2012-03-15',
                source: chartSrc('dx-htn-3', 'condition.code'),
            },
            {
                code: 'Z79.4',
                codeSystem: 'ICD-10',
                label: 'Long-term (current) use of insulin',
                onsetDate: '2020-09-10',
                source: chartSrc('dx-ins-1', 'condition.code'),
            },
        ],
        prescriptions: [],
        allergies: [],
        labs: [],
        encounters: [],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'chart-active-diagnoses-list',
            pid,
            uuid,
            'Run me through his active problem list.',
        ),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------
// Group 3: redaction fixtures
// ---------------------------------------------------------------------

const crossPatientFixture = (): ScenarioFixture => {
    const pid = 4509;
    const uuid = 'p-cg-0509';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Patel, Maya',
            sex: 'F',
            dateOfBirth: '1968-03-15',
            ageYears: 58,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes without complications',
                onsetDate: '2020-01-01',
                source: chartSrc('dx-t2dm-3', 'condition.code'),
            },
        ],
        prescriptions: [
            {
                name: 'Metformin 500 mg',
                dose: '500 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2020-01-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Type 2 diabetes',
                prescriptionId: 'rx-met-2',
                source: chartSrc('rx-met-2', 'medication.name'),
            },
        ],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-04-01',
                type: 'office_visit',
                reason: 'Diabetes follow-up',
                source: chartSrc('enc-6', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    // Stranger's artifact: pid does NOT match the snapshot's patient.
    // The store's pid-scope filter on `searchArtifacts` excludes it
    // before the retriever ever sees it, so the synthesizer never gets
    // cross-patient data. This is the structural redaction property
    // the deleted end-to-end suite's `cross-patient-leakage` case
    // pinned.
    const strangerArtifact: ExtractionArtifact = {
        artifactId: 'aaaa0599-1111-2222-3333-444444444444',
        documentUuid: 'doc-cg-stranger-0599',
        pid: 4599,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'HbA1c',
                    value: 11.3,
                    unit: '%',
                    page: 1,
                    bbox: [40, 200, 380, 220],
                    quote: 'HbA1c 11.3 %',
                    confidence: 0.93,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.93, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: 'e'.repeat(64),
        createdAt: '2026-05-04T16:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'redact-cross-patient-artifact',
            pid,
            uuid,
            'Are there any recent lab results I should know about?',
        ),
        artifacts: [strangerArtifact],
    };
};

const offSchemaSsnFixture = (): ScenarioFixture => {
    const pid = 4510;
    const uuid = 'p-cg-0510';
    const snapshot: BriefingSnapshot = {
        patient: {
            pid,
            uuid,
            displayName: 'Williams, Andre',
            sex: 'M',
            dateOfBirth: '1981-06-22',
            ageYears: 44,
            source: chartSrc(String(pid), 'patient.name'),
        },
        appointment: null,
        diagnoses: [],
        prescriptions: [],
        allergies: [],
        labs: [],
        encounters: [
            {
                encounterDate: '2026-04-25',
                type: 'office_visit',
                reason: 'New patient intake',
                source: chartSrc('enc-7', 'encounter.reason'),
            },
        ],
        reminders: [],
        medications: [],
        labHistory: null,
    };
    // Intake form schemaJson carries:
    //   - a known field (`symptoms`) the retriever DOES project into
    //     ExtractedFactSnippets, and
    //   - an off-schema `ssn` field that is NOT in the projection
    //     allowlist — the retriever drops it, so the synthesizer
    //     never sees it. The structural property this fixture pins:
    //     the SSN pattern produces zero matches in any accepted
    //     claim or rendered prose segment.
    const intakeWithSsn: ExtractionArtifact = {
        artifactId: 'aaaa0510-1111-2222-3333-444444444444',
        documentUuid: 'doc-cg-intake-0510',
        pid,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            symptoms: [
                {
                    value: 'morning fatigue',
                    page: 1,
                    bbox: [50, 300, 360, 320],
                    quote: 'Symptoms: morning fatigue',
                    confidence: 0.85,
                },
            ],
            ssn: '123-45-6789',
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.85, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: 'f'.repeat(64),
        createdAt: '2026-05-04T17:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'redact-hidden-off-schema-ssn',
            pid,
            uuid,
            'What did he write on the intake form? Anything to discuss?',
        ),
        artifacts: [intakeWithSsn],
    };
};

// ---------------------------------------------------------------------
// Case map
// ---------------------------------------------------------------------

export const judgmentMixedCases: Readonly<Record<JudgmentMixedCaseId, CaseSpec>> = {
    'mixed-hba1c-plus-ada-intensification': {
        description:
            'T2DM patient on metformin 500mg BID with new HbA1c 8.4% — the clinician asks about titration vs. adding a second agent, requiring both the lab artifact and a treatment guideline.',
        expectedGate: 'verifier-accepted',
        fixture: hba1cFixture,
    },
    'mixed-ldl-plus-statin-recommendation': {
        description:
            "Hypertensive 58yo male with new LDL 178 — the clinician asks whether the prevention guideline supports starting a statin, requiring both the lipid-panel artifact and the guideline.",
        expectedGate: 'verifier-accepted',
        fixture: ldlFixture,
    },
    'mixed-mammogram-density-plus-screening': {
        description:
            'BIRADS-2 mammogram with heterogeneously dense breasts — the clinician asks for guideline-recommended screening adjustments, requiring both the imaging report and the screening guideline.',
        expectedGate: 'verifier-accepted',
        fixture: mammogramFixture,
    },
    'mixed-bp-plus-second-agent-guidance': {
        description:
            'HTN patient on lisinopril+amlodipine with home-BP-log artifact showing 152-160/92-98 — the clinician asks about a third agent, requiring both the home-BP log and a hypertension guideline.',
        expectedGate: 'verifier-accepted',
        fixture: bpFixture,
    },
    'chart-medication-list-summary': {
        description:
            "71yo on warfarin/metoprolol/atorvastatin/omeprazole — clinician asks 'what meds is she on?' and the answer comes straight from the chart with no retriever needed.",
        expectedGate: 'verifier-accepted',
        fixture: medicationListFixture,
    },
    'chart-last-encounter-recap': {
        description:
            'Chart with one recent annual-physical encounter on 2026-04-22 — clinician asks for the last-visit recap, answerable from the chart alone.',
        expectedGate: 'verifier-accepted',
        fixture: lastEncounterFixture,
    },
    'chart-active-allergies-check': {
        description:
            'Penicillin and latex allergies on file — clinician runs a quick allergy check before writing a prescription; pure chart Q&A.',
        expectedGate: 'verifier-accepted',
        fixture: allergiesFixture,
    },
    'chart-active-diagnoses-list': {
        description:
            'T2DM, HTN, and long-term insulin use on the problem list — clinician asks for the active diagnoses; pure chart recall.',
        expectedGate: 'verifier-accepted',
        fixture: diagnosesFixture,
    },
    'redact-cross-patient-artifact': {
        description:
            "An artifact tagged with a stranger's pid lives in the store; the retriever's pid-scope filter excludes it, so the model answers a benign 'any recent labs?' question with chart-only content and never sees the cross-patient data.",
        expectedGate: 'verifier-accepted',
        fixture: crossPatientFixture,
    },
    'redact-hidden-off-schema-ssn': {
        description:
            "Intake-form artifact with a known symptoms field plus an off-schema 'ssn' field; the retriever's known-field projection drops the SSN before snippets reach the synthesizer, so the rendered answer never contains an SSN-pattern match.",
        expectedGate: 'verifier-accepted',
        fixture: offSchemaSsnFixture,
    },
};
