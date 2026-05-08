/**
 * Document-retrieval scenarios for the conversational-graph eval suite.
 *
 * Each entry simulates a real family-medicine encounter where the
 * physician would expect the agent to surface facts from a freshly
 * extracted document (lab PDF, intake form, imaging report, consult
 * letter, ED summary). The supervisor's job is to recognize that the
 * question wants document-grounded evidence and to invoke
 * `documentEvidenceRetriever`; the verifier's job is to accept the
 * resulting `extracted_document` claim. Both gates are pinned by the
 * shared `expectedGate: 'verifier-accepted'` rubric on every case.
 *
 * Patient archetypes mirror the seed pipeline (Patel diabetic, Chen
 * lipids, etc.) so the snapshots feel like the kind of charts the
 * agent will see in production. Each scenario uses a distinct pid /
 * uuid pair so artifacts can never accidentally cross-bleed if a test
 * harness shares fixtures across cases.
 */

import type { BriefingSnapshot, RequestEnvelope } from '../../../src/graph/types.js';
import type { ExtractionArtifact } from '../../../src/state/extractionArtifacts.js';

import type { CaseSpec, ScenarioFixture } from './_types.js';

export type DocumentRetrievalCaseId =
    | 'doc-recent-hba1c-spike'
    | 'doc-lipid-panel-discussion'
    | 'doc-cbc-anemia-workup'
    | 'doc-intake-chest-pain-triage'
    | 'doc-intake-medication-reconciliation'
    | 'doc-imaging-mammogram-birads3'
    | 'doc-cardiology-consult-letter'
    | 'doc-ed-summary-syncope'
    | 'doc-after-kickoff-routes-to-doc-retriever';

export type { ScenarioFixture, CaseSpec } from './_types.js';

/** `chart`-typed `SourceReference` helper — locator.field is required. */
const chartSrc = (sourceId: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

const ACTOR = {
    userId: 'experiment',
    fhirUser: 'https://emr/Practitioner/experiment',
} as const;
const SITE_ID = 'default';

interface PatientShape {
    readonly pid: number;
    readonly uuid: string;
    readonly displayName: string;
    readonly sex: 'F' | 'M';
    readonly dateOfBirth: string;
    readonly ageYears: number;
}

const buildEnvelope = (
    caseId: DocumentRetrievalCaseId,
    patient: PatientShape,
    question: string,
): RequestEnvelope => ({
    conversationId: `cg-${caseId}`,
    requestId: `cg-${caseId}-req-1`,
    siteId: SITE_ID,
    actor: ACTOR,
    patient: { pid: patient.pid, uuid: patient.uuid },
    task: 'follow_up',
    question,
});

const buildSnapshot = (
    patient: PatientShape,
    diagnoses: BriefingSnapshot['diagnoses'],
    prescriptions: BriefingSnapshot['prescriptions'],
    encounter: { readonly date: string; readonly reason: string; readonly id: string },
): BriefingSnapshot => ({
    patient: {
        pid: patient.pid,
        uuid: patient.uuid,
        displayName: patient.displayName,
        sex: patient.sex,
        dateOfBirth: patient.dateOfBirth,
        ageYears: patient.ageYears,
        source: chartSrc(String(patient.pid), 'patient.name'),
    },
    appointment: null,
    diagnoses,
    prescriptions,
    allergies: [],
    labs: [],
    encounters: [
        {
            encounterDate: encounter.date,
            type: 'office_visit',
            reason: encounter.reason,
            source: chartSrc(encounter.id, 'encounter.reason'),
        },
    ],
    reminders: [],
    medications: [],
    labHistory: null,
});

// --- Case 1: doc-recent-hba1c-spike --------------------------------------

const PATEL: PatientShape = {
    pid: 4301,
    uuid: 'p-cg-0301',
    displayName: 'Patel, Maya',
    sex: 'F',
    dateOfBirth: '1968-03-15',
    ageYears: 58,
};

const buildHba1cSpikeFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        PATEL,
        [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes without complications',
                onsetDate: '2020-01-01',
                source: chartSrc('dx-301-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Metformin 500 mg',
                dose: '500 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2020-01-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Type 2 diabetes',
                prescriptionId: 'rx-301-met',
                source: chartSrc('rx-301-met', 'medication.name'),
            },
        ],
        { date: '2026-04-01', reason: 'Diabetes follow-up', id: 'enc-301-1' },
    );
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0301-bbbb-4444-cccc-5555dddd0301',
        documentUuid: 'doc-cg-lab-0301',
        pid: PATEL.pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'HbA1c',
                    value: 9.2,
                    unit: '%',
                    page: 1,
                    bbox: [40, 200, 380, 220],
                    quote: 'HbA1c 9.2 %',
                    confidence: 0.94,
                },
                {
                    analyte: 'Fasting glucose',
                    value: 178,
                    unit: 'mg/dL',
                    page: 1,
                    bbox: [40, 240, 380, 260],
                    quote: 'Fasting glucose 178 mg/dL',
                    confidence: 0.92,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.94, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '1'.repeat(64),
        createdAt: '2026-05-04T12:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-recent-hba1c-spike',
            PATEL,
            "Her HbA1c just came back at 9.2 — that's a jump from her last reading. What does this PDF show, and is there anything else flagged?",
        ),
        artifacts: [artifact],
    };
};

// --- Case 2: doc-lipid-panel-discussion ----------------------------------

const CHEN: PatientShape = {
    pid: 4302,
    uuid: 'p-cg-0302',
    displayName: 'Chen, David',
    sex: 'M',
    dateOfBirth: '1971-08-22',
    ageYears: 54,
};

const buildLipidPanelFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        CHEN,
        [
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential hypertension',
                onsetDate: '2018-06-01',
                source: chartSrc('dx-302-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Amlodipine 5 mg',
                dose: '5 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2018-06-10',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-302-amlo',
                source: chartSrc('rx-302-amlo', 'medication.name'),
            },
        ],
        { date: '2026-04-15', reason: 'BP follow-up', id: 'enc-302-1' },
    );
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0302-bbbb-4444-cccc-5555dddd0302',
        documentUuid: 'doc-cg-lab-0302',
        pid: CHEN.pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'LDL cholesterol',
                    value: 165,
                    unit: 'mg/dL',
                    page: 1,
                    bbox: [42, 180, 360, 200],
                    quote: 'LDL 165 mg/dL',
                    confidence: 0.95,
                },
                {
                    analyte: 'HDL cholesterol',
                    value: 38,
                    unit: 'mg/dL',
                    page: 1,
                    bbox: [42, 210, 360, 230],
                    quote: 'HDL 38 mg/dL',
                    confidence: 0.95,
                },
                {
                    analyte: 'Triglycerides',
                    value: 230,
                    unit: 'mg/dL',
                    page: 1,
                    bbox: [42, 240, 360, 260],
                    quote: 'Triglycerides 230 mg/dL',
                    confidence: 0.93,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.94, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '2'.repeat(64),
        createdAt: '2026-05-04T13:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-lipid-panel-discussion',
            CHEN,
            'What does his lipid panel show? Anything I should flag for the visit?',
        ),
        artifacts: [artifact],
    };
};

// --- Case 3: doc-cbc-anemia-workup ---------------------------------------

const ROSS: PatientShape = {
    pid: 4303,
    uuid: 'p-cg-0303',
    displayName: 'Ross, Eleanor',
    sex: 'F',
    dateOfBirth: '1958-11-04',
    ageYears: 67,
};

const buildCbcAnemiaFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        ROSS,
        [
            {
                code: 'Z00.00',
                codeSystem: 'ICD-10',
                label: 'Encounter for general adult medical examination',
                onsetDate: '2025-10-01',
                source: chartSrc('dx-303-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Multivitamin',
                dose: '1 tablet',
                route: 'PO',
                frequency: 'daily',
                startDate: '2024-01-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'General supplementation',
                prescriptionId: 'rx-303-mvi',
                source: chartSrc('rx-303-mvi', 'medication.name'),
            },
        ],
        { date: '2026-04-22', reason: 'Annual physical', id: 'enc-303-1' },
    );
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0303-bbbb-4444-cccc-5555dddd0303',
        documentUuid: 'doc-cg-lab-0303',
        pid: ROSS.pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'Hemoglobin',
                    value: 9.4,
                    unit: 'g/dL',
                    page: 1,
                    bbox: [44, 175, 360, 195],
                    quote: 'Hgb 9.4 g/dL (low)',
                    confidence: 0.95,
                },
                {
                    analyte: 'MCV',
                    value: 78,
                    unit: 'fL',
                    page: 1,
                    bbox: [44, 205, 360, 225],
                    quote: 'MCV 78 fL (low)',
                    confidence: 0.94,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.93, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '3'.repeat(64),
        createdAt: '2026-05-04T14:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-cbc-anemia-workup',
            ROSS,
            "Her CBC came back — anything concerning? She's been complaining of fatigue.",
        ),
        artifacts: [artifact],
    };
};

// --- Case 4: doc-intake-chest-pain-triage --------------------------------

const NGUYEN: PatientShape = {
    pid: 4304,
    uuid: 'p-cg-0304',
    displayName: 'Nguyen, Tom',
    sex: 'M',
    dateOfBirth: '1977-02-19',
    ageYears: 48,
};

const buildChestPainIntakeFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        NGUYEN,
        [
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential hypertension',
                onsetDate: '2021-09-15',
                source: chartSrc('dx-304-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Lisinopril 10 mg',
                dose: '10 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2021-09-20',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-304-lis',
                source: chartSrc('rx-304-lis', 'medication.name'),
            },
        ],
        { date: '2026-05-04', reason: 'BP recheck', id: 'enc-304-1' },
    );
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0304-bbbb-4444-cccc-5555dddd0304',
        documentUuid: 'doc-cg-intake-0304',
        pid: NGUYEN.pid,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            chiefComplaints: [
                {
                    text: 'intermittent chest pressure with exertion, last 3 weeks',
                    page: 1,
                    bbox: [50, 280, 380, 300],
                    quote: 'intermittent chest pressure with exertion, last 3 weeks',
                    confidence: 0.91,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.91, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '4'.repeat(64),
        createdAt: '2026-05-04T15:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-intake-chest-pain-triage',
            NGUYEN,
            'What did he write on his intake form today? Anything I need to address right away?',
        ),
        artifacts: [artifact],
    };
};

// --- Case 5: doc-intake-medication-reconciliation ------------------------

const OBRIEN: PatientShape = {
    pid: 4305,
    uuid: 'p-cg-0305',
    displayName: "O'Brien, Margaret",
    sex: 'F',
    dateOfBirth: '1954-06-12',
    ageYears: 71,
};

const buildMedReconFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        OBRIEN,
        [
            {
                code: 'I48.91',
                codeSystem: 'ICD-10',
                label: 'Atrial fibrillation, unspecified',
                onsetDate: '2019-04-10',
                source: chartSrc('dx-305-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Warfarin 5 mg',
                dose: '5 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2019-04-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Atrial fibrillation',
                prescriptionId: 'rx-305-warf',
                source: chartSrc('rx-305-warf', 'medication.name'),
            },
            {
                name: 'Metoprolol 25 mg',
                dose: '25 mg',
                route: 'PO',
                frequency: 'BID',
                startDate: '2019-04-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Rate control',
                prescriptionId: 'rx-305-meto',
                source: chartSrc('rx-305-meto', 'medication.name'),
            },
        ],
        { date: '2026-05-04', reason: 'Anticoagulation follow-up', id: 'enc-305-1' },
    );
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0305-bbbb-4444-cccc-5555dddd0305',
        documentUuid: 'doc-cg-intake-0305',
        pid: OBRIEN.pid,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            medications: [
                {
                    name: "St. John's wort",
                    dose: '300 mg',
                    frequency: 'daily',
                    selfReported: true,
                    page: 2,
                    bbox: [55, 320, 380, 340],
                    quote: "St. John's wort 300mg daily (self-reported supplement)",
                    confidence: 0.9,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.9, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '5'.repeat(64),
        createdAt: '2026-05-04T16:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-intake-medication-reconciliation',
            OBRIEN,
            "What's she listing on the new intake form, and does anything jump out for med reconciliation?",
        ),
        artifacts: [artifact],
    };
};

// --- Case 6: doc-imaging-mammogram-birads3 -------------------------------

const HARPER: PatientShape = {
    pid: 4306,
    uuid: 'p-cg-0306',
    displayName: 'Harper, Jane',
    sex: 'F',
    dateOfBirth: '1973-01-29',
    ageYears: 52,
};

const buildMammogramFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        HARPER,
        [
            {
                code: 'Z12.31',
                codeSystem: 'ICD-10',
                label: 'Encounter for screening mammogram',
                onsetDate: '2026-04-10',
                source: chartSrc('dx-306-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Vitamin D3 1000 IU',
                dose: '1000 IU',
                route: 'PO',
                frequency: 'daily',
                startDate: '2024-03-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Supplementation',
                prescriptionId: 'rx-306-vitd',
                source: chartSrc('rx-306-vitd', 'medication.name'),
            },
        ],
        { date: '2026-04-10', reason: 'Screening mammogram', id: 'enc-306-1' },
    );
    // Modeled as a lab_pdf (the supported docType set is currently
    // {lab_pdf, intake_form}); the schema content is the imaging
    // report's bottom-line BIRADS reading and recommendation, which is
    // the question's load-bearing answer.
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0306-bbbb-4444-cccc-5555dddd0306',
        documentUuid: 'doc-cg-imaging-0306',
        pid: HARPER.pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'Mammogram BIRADS',
                    value: 3,
                    unit: 'category',
                    page: 1,
                    bbox: [50, 420, 410, 440],
                    quote: 'BIRADS-3: probably benign; recommend short-interval follow-up in 6 months',
                    confidence: 0.93,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.93, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '6'.repeat(64),
        createdAt: '2026-05-04T17:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-imaging-mammogram-birads3',
            HARPER,
            "Her mammogram report just dropped — what's the BIRADS, and what's the recommendation?",
        ),
        artifacts: [artifact],
    };
};

// --- Case 7: doc-cardiology-consult-letter -------------------------------

const SANTOS: PatientShape = {
    pid: 4307,
    uuid: 'p-cg-0307',
    displayName: 'Santos, Carlos',
    sex: 'M',
    dateOfBirth: '1963-07-08',
    ageYears: 62,
};

const buildCardiologyConsultFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        SANTOS,
        [
            {
                code: 'I25.10',
                codeSystem: 'ICD-10',
                label: 'Atherosclerotic heart disease of native coronary artery without angina pectoris',
                onsetDate: '2026-02-10',
                source: chartSrc('dx-307-1', 'condition.code'),
            },
            {
                code: 'I21.9',
                codeSystem: 'ICD-10',
                label: 'Acute myocardial infarction, unspecified',
                onsetDate: '2026-02-10',
                source: chartSrc('dx-307-2', 'condition.code'),
            },
        ],
        [
            {
                name: 'Aspirin 81 mg',
                dose: '81 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2026-02-12',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Secondary prevention',
                prescriptionId: 'rx-307-asa',
                source: chartSrc('rx-307-asa', 'medication.name'),
            },
            {
                name: 'Atorvastatin 80 mg',
                dose: '80 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2026-02-12',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Post-MI lipid management',
                prescriptionId: 'rx-307-atorv',
                source: chartSrc('rx-307-atorv', 'medication.name'),
            },
            {
                name: 'Metoprolol succinate 50 mg',
                dose: '50 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2026-02-12',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Post-MI cardioprotection',
                prescriptionId: 'rx-307-meto',
                source: chartSrc('rx-307-meto', 'medication.name'),
            },
        ],
        { date: '2026-04-28', reason: 'Post-MI follow-up', id: 'enc-307-1' },
    );
    // The cardiology consult letter is modeled as an intake_form
    // (free-text-heavy correspondence) — the supported docType set
    // is {lab_pdf, intake_form}; intake_form's flexible schema is the
    // closer fit for narrative consult content. The schema body
    // carries the recommendation text the question is about.
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0307-bbbb-4444-cccc-5555dddd0307',
        documentUuid: 'doc-cg-consult-0307',
        pid: SANTOS.pid,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            recommendations: [
                {
                    text: 'Add empagliflozin 10 mg daily for cardiovascular risk reduction',
                    page: 2,
                    bbox: [60, 360, 420, 380],
                    quote: 'Recommend adding empagliflozin 10 mg daily for cardiovascular risk reduction',
                    confidence: 0.94,
                },
                {
                    text: 'Cardiology follow-up in 4 weeks',
                    page: 2,
                    bbox: [60, 390, 420, 410],
                    quote: 'Follow-up in cardiology clinic in 4 weeks',
                    confidence: 0.95,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.94, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '7'.repeat(64),
        createdAt: '2026-05-04T18:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-cardiology-consult-letter',
            SANTOS,
            'What did the cardiology consult letter say? Anything I need to start or change?',
        ),
        artifacts: [artifact],
    };
};

// --- Case 8: doc-ed-summary-syncope --------------------------------------

const KOWALSKI: PatientShape = {
    pid: 4308,
    uuid: 'p-cg-0308',
    displayName: 'Kowalski, Helen',
    sex: 'F',
    dateOfBirth: '1947-05-30',
    ageYears: 78,
};

const buildEdSummaryFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        KOWALSKI,
        [
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential hypertension',
                onsetDate: '2010-05-01',
                source: chartSrc('dx-308-1', 'condition.code'),
            },
            {
                code: 'I50.9',
                codeSystem: 'ICD-10',
                label: 'Heart failure, unspecified',
                onsetDate: '2022-11-12',
                source: chartSrc('dx-308-2', 'condition.code'),
            },
        ],
        [
            {
                name: 'Lisinopril 20 mg',
                dose: '20 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2010-05-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-308-lis',
                source: chartSrc('rx-308-lis', 'medication.name'),
            },
            {
                name: 'Atenolol 50 mg',
                dose: '50 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2015-08-01',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Rate control',
                prescriptionId: 'rx-308-aten',
                source: chartSrc('rx-308-aten', 'medication.name'),
            },
            {
                name: 'Furosemide 40 mg',
                dose: '40 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2022-11-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Heart failure',
                prescriptionId: 'rx-308-furo',
                source: chartSrc('rx-308-furo', 'medication.name'),
            },
        ],
        { date: '2026-04-30', reason: 'Post-ED follow-up', id: 'enc-308-1' },
    );
    // ED summary modeled as an intake_form — intake_form's free-text
    // schema is the closer fit for the narrative summary content
    // than lab_pdf's analyte-shaped schema.
    const artifact: ExtractionArtifact = {
        artifactId: 'aaaa0308-bbbb-4444-cccc-5555dddd0308',
        documentUuid: 'doc-cg-ed-0308',
        pid: KOWALSKI.pid,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            edSummary: [
                {
                    section: 'history',
                    text: 'Syncope episode at home, orthostatic on exam in ED',
                    page: 1,
                    bbox: [55, 200, 420, 220],
                    quote: 'Syncope episode at home; orthostatic vitals positive on ED exam',
                    confidence: 0.93,
                },
                {
                    section: 'workup',
                    text: 'ECG, troponin, head CT all negative; cardiac and neuro workup unremarkable',
                    page: 1,
                    bbox: [55, 230, 420, 250],
                    quote: 'ECG, troponin, head CT negative; cardiac and neuro workup unremarkable',
                    confidence: 0.94,
                },
                {
                    section: 'recommendation',
                    text: 'Primary-care follow-up to review medications, especially antihypertensives and diuretic',
                    page: 2,
                    bbox: [55, 360, 420, 380],
                    quote: 'Recommend primary-care follow-up to review medications, especially antihypertensives and diuretic',
                    confidence: 0.95,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.94, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '8'.repeat(64),
        createdAt: '2026-05-04T19:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    return {
        snapshot,
        envelope: buildEnvelope(
            'doc-ed-summary-syncope',
            KOWALSKI,
            'What did the ED note say about her syncope episode last week? What did they recommend?',
        ),
        artifacts: [artifact],
    };
};

// --- Case 9: doc-after-kickoff-routes-to-doc-retriever -------------------
//
// Regression case for a production bug where the supervisor ran
// `kickoffExtraction` (the document persisted, the artifact was written)
// and then went STRAIGHT to `synthesize` without invoking
// `documentEvidenceRetriever`. The synthesizer therefore had zero
// `documentSnippets` and the answer cited only chart values, silently
// omitting every fact in the document the clinician had just attached
// the doc to ask about. The supervisor's reasoning was "all necessary
// context has been gathered: the lab PDF has been extracted
// (kickoffExtraction)" — confusing artifact persistence with retrieval
// availability.
//
// The fixture forces the kickoff path by setting `envelope.pendingUploads`,
// pre-seeds the artifact in `searchArtifacts` so `documentEvidenceRetriever`
// has something to return, and asserts `verifier-accepted` (i.e. at
// least one extracted_document claim accepted). The eval target uses
// the test-only `kickoffExtractionNodeOverride` from `BriefingGraphDeps`
// to simulate a successful kickoff without standing up a real
// `PipelineRunner`.

const FELDMAN: PatientShape = {
    pid: 4309,
    uuid: 'p-cg-0309',
    displayName: 'Feldman, Robert',
    sex: 'M',
    dateOfBirth: '1971-06-08',
    ageYears: 54,
};

export const DOC_AFTER_KICKOFF_DOCUMENT_UUID = 'doc-cg-postkickoff-0309';
export const DOC_AFTER_KICKOFF_ARTIFACT_ID = 'aaaa0309-bbbb-4444-cccc-5555dddd0309';

const buildPostKickoffFixture = (): ScenarioFixture => {
    const snapshot = buildSnapshot(
        FELDMAN,
        [
            {
                code: 'I10',
                codeSystem: 'ICD-10',
                label: 'Essential hypertension',
                onsetDate: '2018-04-10',
                source: chartSrc('dx-309-1', 'condition.code'),
            },
        ],
        [
            {
                name: 'Lisinopril 20 mg',
                dose: '20 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2018-04-15',
                stopDate: null,
                prescriber: 'Dr. Patel',
                indication: 'Hypertension',
                prescriptionId: 'rx-309-lis',
                source: chartSrc('rx-309-lis', 'medication.name'),
            },
        ],
        { date: '2026-05-04', reason: 'Lab review', id: 'enc-309-1' },
    );
    const artifact: ExtractionArtifact = {
        artifactId: DOC_AFTER_KICKOFF_ARTIFACT_ID,
        documentUuid: DOC_AFTER_KICKOFF_DOCUMENT_UUID,
        pid: FELDMAN.pid,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte: 'Creatinine',
                    value: 1.4,
                    unit: 'mg/dL',
                    page: 1,
                    bbox: [60, 432, 860, 22],
                    quote: 'Creatinine 1.4 H 0.74 - 1.35 mg/dL',
                    confidence: 0.97,
                },
                {
                    analyte: 'Potassium',
                    value: 3.3,
                    unit: 'mmol/L',
                    page: 1,
                    bbox: [60, 510, 860, 22],
                    quote: 'Potassium 3.3 L 3.6 - 5.2 mmol/L',
                    confidence: 0.97,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: { self_reported: 0.97, schema_warning_count: 0, patient_match: 'full' },
        status: 'pending_confirmation',
        documentHash: '9'.repeat(64),
        createdAt: '2026-05-04T20:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    };
    const baseEnv = buildEnvelope(
        'doc-after-kickoff-routes-to-doc-retriever',
        FELDMAN,
        'What does the lab I just attached show, and is anything outside the reference range?',
    );
    // pendingUploads forces the supervisor down the kickoffExtraction
    // path on iteration 1 — exactly the production scenario where the
    // bug surfaced.
    const envelope: RequestEnvelope = {
        ...baseEnv,
        pendingUploads: [
            {
                documentUuid: DOC_AFTER_KICKOFF_DOCUMENT_UUID,
                docType: 'lab_pdf',
                canonicalExt: 'pdf',
            },
        ],
    };
    return { snapshot, envelope, artifacts: [artifact] };
};

export const documentRetrievalCases: Readonly<Record<DocumentRetrievalCaseId, CaseSpec>> = {
    'doc-recent-hba1c-spike': {
        description:
            'Diabetic patient on metformin; clinician asks about a freshly extracted lab PDF showing HbA1c 9.2 % up from a prior 7.8 %.',
        expectedGate: 'verifier-accepted',
        fixture: buildHba1cSpikeFixture,
    },
    'doc-lipid-panel-discussion': {
        description:
            "Hypertensive 54-year-old male; clinician asks for the read on a lipid panel PDF (LDL 165, HDL 38, TG 230) ahead of the visit.",
        expectedGate: 'verifier-accepted',
        fixture: buildLipidPanelFixture,
    },
    'doc-cbc-anemia-workup': {
        description:
            "67-year-old female with fatigue; clinician asks about a CBC PDF showing Hgb 9.4 g/dL with low MCV — clean microcytic-anemia cue.",
        expectedGate: 'verifier-accepted',
        fixture: buildCbcAnemiaFixture,
    },
    'doc-intake-chest-pain-triage': {
        description:
            "Hypertensive 48-year-old male; clinician asks what he wrote on today's intake form, which reports exertional chest pressure for 3 weeks.",
        expectedGate: 'verifier-accepted',
        fixture: buildChestPainIntakeFixture,
    },
    'doc-intake-medication-reconciliation': {
        description:
            "71-year-old on warfarin and metoprolol; clinician asks the agent to scan today's intake form, which lists self-reported St. John's wort.",
        expectedGate: 'verifier-accepted',
        fixture: buildMedReconFixture,
    },
    'doc-imaging-mammogram-birads3': {
        description:
            '52-year-old female; clinician asks for the bottom-line read of a freshly extracted mammogram report — BIRADS-3, 6-month follow-up.',
        expectedGate: 'verifier-accepted',
        fixture: buildMammogramFixture,
    },
    'doc-cardiology-consult-letter': {
        description:
            'Post-MI 62-year-old male on aspirin/atorvastatin/metoprolol; clinician asks what the new cardiology consult letter recommends adding.',
        expectedGate: 'verifier-accepted',
        fixture: buildCardiologyConsultFixture,
    },
    'doc-ed-summary-syncope': {
        description:
            "78-year-old female on lisinopril/atenolol/furosemide; clinician asks what last week's ED summary said about her syncope episode and the workup recommendation.",
        expectedGate: 'verifier-accepted',
        fixture: buildEdSummaryFixture,
    },
    'doc-after-kickoff-routes-to-doc-retriever': {
        description:
            'Regression: clinician just uploaded a lab PDF (envelope.pendingUploads is set). Supervisor must run kickoffExtraction THEN documentEvidenceRetriever before synthesize. Pre-prompt-fix the supervisor went kickoffExtraction → retrieveChart → evidenceRetriever → synthesize, skipping documentEvidenceRetriever, and the answer silently cited only chart values — no extracted_document claims. Verifier-accepted requires at least one extracted_document claim, which is impossible without documentEvidenceRetriever.',
        expectedGate: 'verifier-accepted',
        fixture: buildPostKickoffFixture,
    },
};
