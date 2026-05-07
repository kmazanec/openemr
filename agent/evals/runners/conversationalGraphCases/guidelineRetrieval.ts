/**
 * Guideline-retrieval scenarios for the conversational-graph eval suite.
 *
 * Each case is a realistic clinic interaction whose answer naturally
 * depends on a clinical guideline that lives in the deployed corpus
 * (USPSTF primarily, with ADA / CDC / AGS-Beers as fallback). The
 * supervisor's expected behavior is to recognize the question as a
 * guideline-shaped question, route to `evidenceRetriever`
 * (Pinecone+Cohere), receive snippets, and the synthesizer should
 * emit at least one `guideline`-typed claim that the verifier accepts.
 *
 * `artifacts` is empty in every case — these are guideline-only
 * scenarios. Chart context the question references (age, sex,
 * relevant diagnoses, current Rx) is materialized in the snapshot so
 * the supervisor can ground its routing decision.
 *
 * Patient identifiers are deliberately distinct per case (`pid`
 * 4401-4408, `uuid` `p-cg-04XX`) so concurrent runs of the suite
 * never reuse a conversational-graph patient scope.
 */

import type { BriefingSnapshot, RequestEnvelope } from '../../../src/graph/types.js';
import type {
    Allergy,
    Diagnosis,
    Encounter,
    LabObservation,
    Prescription,
    SourceReference,
} from '../../../src/snapshot/types.js';

import type { CaseSpec, ScenarioFixture } from './_types.js';

export type GuidelineRetrievalCaseId =
    | 'guide-crc-screening-cadence'
    | 'guide-statin-initiation-criteria'
    | 'guide-gestational-diabetes-screening'
    | 'guide-mammography-schedule'
    | 'guide-bone-density-screening'
    | 'guide-hypertension-target-elderly'
    | 'guide-aspirin-primary-prevention'
    | 'guide-tobacco-cessation-intervention';

export type { ScenarioFixture, CaseSpec } from './_types.js';

const chartSrc = (sourceId: string, field: string): SourceReference => ({
    source_type: 'chart',
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

interface PatientCore {
    readonly pid: number;
    readonly uuid: string;
    readonly displayName: string;
    readonly sex: 'F' | 'M';
    readonly dateOfBirth: string;
    readonly ageYears: number;
}

const buildSnapshot = (args: {
    readonly patient: PatientCore;
    readonly diagnoses?: readonly Diagnosis[];
    readonly prescriptions?: readonly Prescription[];
    readonly allergies?: readonly Allergy[];
    readonly labs?: readonly LabObservation[];
    readonly encounters?: readonly Encounter[];
}): BriefingSnapshot => ({
    patient: {
        pid: args.patient.pid,
        uuid: args.patient.uuid,
        displayName: args.patient.displayName,
        sex: args.patient.sex,
        dateOfBirth: args.patient.dateOfBirth,
        ageYears: args.patient.ageYears,
        source: chartSrc(String(args.patient.pid), 'patient.name'),
    },
    appointment: null,
    diagnoses: args.diagnoses ?? [],
    prescriptions: args.prescriptions ?? [],
    allergies: args.allergies ?? [],
    labs: args.labs ?? [],
    encounters: args.encounters ?? [],
    reminders: [],
    medications: [],
    labHistory: null,
});

const buildEnvelope = (args: {
    readonly caseId: GuidelineRetrievalCaseId;
    readonly pid: number;
    readonly uuid: string;
    readonly question: string;
}): RequestEnvelope => ({
    conversationId: `cg-${args.caseId}`,
    requestId: `cg-${args.caseId}-req-1`,
    siteId: 'default',
    actor: {
        userId: 'experiment',
        fhirUser: 'https://emr/Practitioner/experiment',
    },
    patient: { pid: args.pid, uuid: args.uuid },
    task: 'follow_up',
    question: args.question,
});

// ---------------------------------------------------------------------------
// Case 1: CRC screening cadence — USPSTF colorectal-cancer-screening (B).
// ---------------------------------------------------------------------------

const crcScreeningCadence = (): ScenarioFixture => {
    const pid = 4401;
    const uuid = 'p-cg-0401';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Hartman, James',
                sex: 'M',
                dateOfBirth: '1979-02-12',
                ageYears: 47,
            },
            encounters: [
                {
                    encounterDate: '2026-04-22',
                    type: 'office_visit',
                    reason: 'Annual wellness visit',
                    source: chartSrc('enc-4401-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-crc-screening-cadence',
            pid,
            uuid,
            question:
                "At his age, what does the screening guideline say about colorectal cancer — when should we offer it, and how often?",
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 2: Statin initiation in T2DM — USPSTF statin-use-in-adults (B).
// ---------------------------------------------------------------------------

const statinInitiationCriteria = (): ScenarioFixture => {
    const pid = 4402;
    const uuid = 'p-cg-0402';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Okonkwo, Daniel',
                sex: 'M',
                dateOfBirth: '1969-08-30',
                ageYears: 56,
            },
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes without complications',
                    onsetDate: '2019-06-10',
                    source: chartSrc('dx-4402-1', 'condition.code'),
                },
            ],
            prescriptions: [
                {
                    name: 'Metformin 1000 mg',
                    dose: '1000 mg',
                    route: 'PO',
                    frequency: 'BID',
                    startDate: '2019-06-12',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'Type 2 diabetes',
                    prescriptionId: 'rx-4402-met',
                    source: chartSrc('rx-4402-met', 'medication.name'),
                },
            ],
            labs: [
                {
                    analyte: 'LDL cholesterol',
                    value: '142',
                    unit: 'mg/dL',
                    referenceRange: '<100',
                    abnormalFlag: 'H',
                    observedAt: '2026-04-10',
                    source: chartSrc('lab-4402-ldl', 'observation.value'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-04-15',
                    type: 'office_visit',
                    reason: 'Diabetes follow-up, lipid review',
                    source: chartSrc('enc-4402-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-statin-initiation-criteria',
            pid,
            uuid,
            question:
                'Given his diabetes and that LDL, what does the prevention guideline say about starting a statin?',
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 3: Gestational diabetes screening — USPSTF gestational-diabetes-screening (B).
// ---------------------------------------------------------------------------

const gestationalDiabetesScreening = (): ScenarioFixture => {
    const pid = 4403;
    const uuid = 'p-cg-0403';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Alvarez, Sofia',
                sex: 'F',
                dateOfBirth: '1993-11-04',
                ageYears: 32,
            },
            diagnoses: [
                {
                    code: 'Z34.83',
                    codeSystem: 'ICD-10',
                    label: 'Encounter for supervision of normal pregnancy, third trimester',
                    onsetDate: '2025-11-02',
                    source: chartSrc('dx-4403-1', 'condition.code'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-04-28',
                    type: 'prenatal_visit',
                    reason: 'Routine prenatal visit, 24 weeks gestation',
                    source: chartSrc('enc-4403-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-gestational-diabetes-screening',
            pid,
            uuid,
            question:
                "She's at 24 weeks — what's the guideline-recommended approach for gestational diabetes screening?",
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 4: Mammography cadence — USPSTF breast-cancer-screening (B).
// ---------------------------------------------------------------------------

const mammographySchedule = (): ScenarioFixture => {
    const pid = 4404;
    const uuid = 'p-cg-0404';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Reyes, Maria',
                sex: 'F',
                dateOfBirth: '1973-09-19',
                ageYears: 52,
            },
            encounters: [
                {
                    encounterDate: '2026-04-30',
                    type: 'office_visit',
                    reason: 'Annual wellness visit',
                    source: chartSrc('enc-4404-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-mammography-schedule',
            pid,
            uuid,
            question:
                "At 52 with average risk, what's the current screening recommendation for mammography? Annual or biennial?",
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 5: Osteoporosis screening — USPSTF osteoporosis-screening (B).
// ---------------------------------------------------------------------------

const boneDensityScreening = (): ScenarioFixture => {
    const pid = 4405;
    const uuid = 'p-cg-0405';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Whitfield, Eleanor',
                sex: 'F',
                dateOfBirth: '1958-05-14',
                ageYears: 67,
            },
            diagnoses: [
                {
                    code: 'Z78.0',
                    codeSystem: 'ICD-10',
                    label: 'Asymptomatic postmenopausal status',
                    onsetDate: '2010-06-01',
                    source: chartSrc('dx-4405-1', 'condition.code'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-04-18',
                    type: 'office_visit',
                    reason: 'Annual wellness visit, postmenopausal',
                    source: chartSrc('enc-4405-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-bone-density-screening',
            pid,
            uuid,
            question:
                'Should we be screening her for osteoporosis at this point? What does the guideline say about timing?',
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 6: BP target in elderly — ADA/CDC/Million-Hearts hypertension management.
// (If the corpus has no BP-target rec relevant to the question, the
// supervisor will gap-emit, which is acceptable per the task spec —
// `expectedGate` still pins to `verifier-accepted` because the corpus
// DOES include both ADA HTN and CDC Million-Hearts HTN protocols.)
// ---------------------------------------------------------------------------

const hypertensionTargetElderly = (): ScenarioFixture => {
    const pid = 4406;
    const uuid = 'p-cg-0406';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Davies, Margaret',
                sex: 'F',
                dateOfBirth: '1947-12-22',
                ageYears: 78,
            },
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2008-03-14',
                    source: chartSrc('dx-4406-1', 'condition.code'),
                },
            ],
            prescriptions: [
                {
                    name: 'Lisinopril 20 mg',
                    dose: '20 mg',
                    route: 'PO',
                    frequency: 'daily',
                    startDate: '2018-09-04',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'Hypertension',
                    prescriptionId: 'rx-4406-lis',
                    source: chartSrc('rx-4406-lis', 'medication.name'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-04-20',
                    type: 'office_visit',
                    reason: 'Hypertension follow-up',
                    source: chartSrc('enc-4406-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-hypertension-target-elderly',
            pid,
            uuid,
            question:
                "For someone her age with hypertension, what's the current guideline-recommended BP target?",
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 7: Aspirin primary prevention — USPSTF aspirin-to-prevent-cvd (C/D).
// ---------------------------------------------------------------------------

const aspirinPrimaryPrevention = (): ScenarioFixture => {
    const pid = 4407;
    const uuid = 'p-cg-0407';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Brennan, Thomas',
                sex: 'M',
                dateOfBirth: '1967-07-08',
                ageYears: 58,
            },
            diagnoses: [
                {
                    code: 'I10',
                    codeSystem: 'ICD-10',
                    label: 'Essential (primary) hypertension',
                    onsetDate: '2015-02-19',
                    source: chartSrc('dx-4407-1', 'condition.code'),
                },
            ],
            prescriptions: [
                {
                    name: 'Amlodipine 5 mg',
                    dose: '5 mg',
                    route: 'PO',
                    frequency: 'daily',
                    startDate: '2015-02-21',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: 'Hypertension',
                    prescriptionId: 'rx-4407-aml',
                    source: chartSrc('rx-4407-aml', 'medication.name'),
                },
            ],
            labs: [
                {
                    analyte: 'LDL cholesterol',
                    value: '145',
                    unit: 'mg/dL',
                    referenceRange: '<100',
                    abnormalFlag: 'H',
                    observedAt: '2026-04-05',
                    source: chartSrc('lab-4407-ldl', 'observation.value'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-04-12',
                    type: 'office_visit',
                    reason: 'CV risk review',
                    source: chartSrc('enc-4407-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-aspirin-primary-prevention',
            pid,
            uuid,
            question:
                "He's 58 and asks about taking aspirin daily for prevention — what does the current guideline say?",
        }),
        artifacts: [],
    };
};

// ---------------------------------------------------------------------------
// Case 8: Tobacco cessation interventions —
// USPSTF tobacco-use-in-adults-and-pregnant-women-counseling-and-interventions (A).
// ---------------------------------------------------------------------------

const tobaccoCessationIntervention = (): ScenarioFixture => {
    const pid = 4408;
    const uuid = 'p-cg-0408';
    return {
        snapshot: buildSnapshot({
            patient: {
                pid,
                uuid,
                displayName: 'Carter, Wesley',
                sex: 'M',
                dateOfBirth: '1981-10-26',
                ageYears: 44,
            },
            diagnoses: [
                {
                    code: 'F17.210',
                    codeSystem: 'ICD-10',
                    label: 'Nicotine dependence, cigarettes, uncomplicated',
                    onsetDate: '2014-08-01',
                    source: chartSrc('dx-4408-1', 'condition.code'),
                },
            ],
            encounters: [
                {
                    encounterDate: '2026-04-25',
                    type: 'office_visit',
                    reason: 'Routine follow-up, tobacco use counseling',
                    source: chartSrc('enc-4408-1', 'encounter.reason'),
                },
            ],
        }),
        envelope: buildEnvelope({
            caseId: 'guide-tobacco-cessation-intervention',
            pid,
            uuid,
            question:
                "He's still smoking despite us talking about it — what does the guideline say about which cessation interventions actually work?",
        }),
        artifacts: [],
    };
};

export const guidelineRetrievalCases: Readonly<Record<GuidelineRetrievalCaseId, CaseSpec>> = {
    'guide-crc-screening-cadence': {
        description:
            '47-year-old asymptomatic male, no family history, asks at his annual visit when CRC screening should start and how often (USPSTF colorectal-cancer-screening, 45-75 B-recommendation).',
        expectedGate: 'verifier-accepted',
        fixture: crcScreeningCadence,
    },
    'guide-statin-initiation-criteria': {
        description:
            '56-year-old male with T2DM on metformin and a recent LDL of 142 mg/dL; clinician asks whether prevention guidelines indicate starting a statin (USPSTF statin-use-in-adults primary-prevention B-recommendation, 40-75 with risk factors).',
        expectedGate: 'verifier-accepted',
        fixture: statinInitiationCriteria,
    },
    'guide-gestational-diabetes-screening': {
        description:
            '32-year-old at 24 weeks gestation; clinician asks the guideline-recommended approach for screening (USPSTF gestational-diabetes-screening B-recommendation, 24-week threshold).',
        expectedGate: 'verifier-accepted',
        fixture: gestationalDiabetesScreening,
    },
    'guide-mammography-schedule': {
        description:
            '52-year-old average-risk female asks whether mammography should be annual or biennial (USPSTF breast-cancer-screening 50-74 biennial B-recommendation).',
        expectedGate: 'verifier-accepted',
        fixture: mammographySchedule,
    },
    'guide-bone-density-screening': {
        description:
            '67-year-old postmenopausal female; clinician asks whether and when to screen for osteoporosis (USPSTF osteoporosis-screening B-recommendation for women >=65).',
        expectedGate: 'verifier-accepted',
        fixture: boneDensityScreening,
    },
    'guide-hypertension-target-elderly': {
        description:
            '78-year-old hypertensive female on lisinopril; clinician asks the guideline-recommended BP target for her age (covered by ADA hypertension-and-blood-pressure-management and CDC Million-Hearts hypertension-treatment-protocols in the corpus).',
        expectedGate: 'verifier-accepted',
        fixture: hypertensionTargetElderly,
    },
    'guide-aspirin-primary-prevention': {
        description:
            '58-year-old male with HTN and elevated LDL but no prior CVD events asks about daily aspirin for prevention (USPSTF aspirin-to-prevent-cardiovascular-disease 40-59 / 60+ recommendations).',
        expectedGate: 'verifier-accepted',
        fixture: aspirinPrimaryPrevention,
    },
    'guide-tobacco-cessation-intervention': {
        description:
            '44-year-old male active smoker; clinician asks which cessation interventions are guideline-supported (USPSTF tobacco-use-in-adults-and-pregnant-women-counseling-and-interventions A-recommendation: behavioral + pharmacologic combined).',
        expectedGate: 'verifier-accepted',
        fixture: tobaccoCessationIntervention,
    },
};
