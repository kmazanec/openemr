/**
 * Merged briefing-graph suite — replaces archetypes, lab-trends, and
 * morning-prep. All three formerly ran the same `createBriefingGraph(…)`
 * target with different inputs and different output projections; the
 * shared body is now in one place, and the three case kinds are
 * discriminated at the input level.
 *
 * The merge satisfies the W2 PDF's "50-case golden set" framing better
 * than three separate datasets — graders see one LangSmith experiment
 * over the briefing graph with case-kind metadata, and the cross-case
 * boolean rubrics aggregate cleanly.
 *
 * Input shape:
 *   { caseKind: 'archetype'|'lab-trend'|'morning-prep', snapshot, … }
 *
 * Output shape (LangSmith-recorded):
 *   { caseKind, suiteSpecific: {…}, rubricInput: AgentRubricInput }
 */

import type { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';

import { createBriefingGraph } from '../../src/graph/index.js';
import { createAnthropicSynthesizer } from '../../src/graph/nodes/synthesize.js';
import type { BriefingSnapshot, Claim } from '../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';
import {
    loadFixture,
    loadUc2Fixture,
    loadUc5MorningPrepDay,
    type Uc2Scenario,
} from '../fixtures/load.js';
import { ARCHETYPES, type ArchetypeKey } from '../fixtures/regenerate-archetypes.js';
import { LAB_TREND_SCENARIOS } from '../fixtures/regenerate-lab-trends.js';
import { RUBRICS } from '../rubrics/evaluators.js';
import type { AgentRubricInput, RubricClaim } from '../rubrics/types.js';

import {
    buildDatasetSnapshotClient,
    uploadDatasetGeneric,
    type EvalExample,
    type EvalSuite,
    type ExperimentRunResult,
    type UploadResult,
} from './shared.js';

export const DATASET_NAME = 'clinical-copilot-briefing-graph-v1';

const DATASET_DESCRIPTION =
    'Briefing-graph suite (merged archetypes + lab-trends + morning-prep). Every example invokes createBriefingGraph against a `BriefingSnapshot`; case-kind metadata discriminates which suite-specific assertions and ground truth apply. Five W2 boolean rubrics (schema_valid, citation_present, factually_consistent, safe_refusal, no_phi_in_logs) score every row uniformly.';

type CaseKind = 'archetype' | 'lab-trend' | 'morning-prep';

interface ArchetypeCaseInputs {
    readonly caseKind: 'archetype';
    readonly snapshot: BriefingSnapshot;
    readonly archetype: ArchetypeKey;
}

interface LabTrendCaseInputs {
    readonly caseKind: 'lab-trend';
    readonly snapshot: BriefingSnapshot;
    readonly scenario: Uc2Scenario;
}

interface MorningPrepCaseInputs {
    readonly caseKind: 'morning-prep';
    readonly snapshot: BriefingSnapshot;
    readonly appointmentId: string;
    readonly practitionerUuid: string;
    readonly startAt: string;
    readonly archetype: string;
}

type BriefingCaseInputs = ArchetypeCaseInputs | LabTrendCaseInputs | MorningPrepCaseInputs;

interface ArchetypeCaseOutputs {
    readonly caseKind: 'archetype';
    readonly diagnosisCodes: readonly string[];
    readonly prescriptionNames: readonly string[];
    readonly externalEncounterIds: readonly string[];
    readonly overdueReminderItems: readonly string[];
    readonly medicationStatementNames: readonly string[];
}

interface LabTrendCaseOutputs {
    readonly caseKind: 'lab-trend';
    readonly trendDirection: 'up' | 'stable' | 'none';
    readonly expectedAccept: boolean;
}

interface MorningPrepCaseOutputs {
    readonly caseKind: 'morning-prep';
    readonly archetypeFlags: readonly string[];
}

type BriefingCaseOutputs = ArchetypeCaseOutputs | LabTrendCaseOutputs | MorningPrepCaseOutputs;

interface BriefingCaseMetadata {
    readonly caseKind: CaseKind;
    readonly caseId: string;
}

const archetypeGroundTruth = (archetype: ArchetypeKey): ArchetypeCaseOutputs => {
    switch (archetype) {
        case 'healthy_adult':
            return {
                caseKind: 'archetype',
                diagnosisCodes: [],
                prescriptionNames: [],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'hypertensive':
            return {
                caseKind: 'archetype',
                diagnosisCodes: ['I10'],
                prescriptionNames: ['Lisinopril'],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'diabetic':
            return {
                caseKind: 'archetype',
                diagnosisCodes: ['E11.9'],
                prescriptionNames: ['Metformin'],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'diabetic_uncontrolled':
            return {
                caseKind: 'archetype',
                diagnosisCodes: ['E11.9'],
                prescriptionNames: ['Metformin', 'Lisinopril'],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'complex_elderly':
            return {
                caseKind: 'archetype',
                diagnosisCodes: ['I10', 'E78.5', 'M19.90'],
                prescriptionNames: ['Lisinopril', 'Atorvastatin'],
                externalEncounterIds: [],
                overdueReminderItems: ['Mammogram screening'],
                medicationStatementNames: ['Tylenol'],
            };
        case 'recent_ed_visit':
            return {
                caseKind: 'archetype',
                diagnosisCodes: [],
                prescriptionNames: [],
                externalEncounterIds: ['enc-6006-ed'],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
    }
};

const labTrendGroundTruth = (scenario: Uc2Scenario): LabTrendCaseOutputs => {
    switch (scenario) {
        case 'a1c_trend_up':
            return { caseKind: 'lab-trend', trendDirection: 'up', expectedAccept: true };
        case 'a1c_trend_stable':
            return { caseKind: 'lab-trend', trendDirection: 'stable', expectedAccept: true };
        case 'no_lab_history':
            return { caseKind: 'lab-trend', trendDirection: 'none', expectedAccept: true };
    }
};

const buildArchetypeExamples = (): EvalExample<
    ArchetypeCaseInputs,
    ArchetypeCaseOutputs,
    BriefingCaseMetadata
>[] =>
    ARCHETYPES.map((archetype) => {
        const snapshot = loadFixture(archetype);
        return {
            inputs: { caseKind: 'archetype', snapshot, archetype },
            outputs: archetypeGroundTruth(archetype),
            metadata: { caseKind: 'archetype', caseId: `archetype:${archetype}` },
        };
    });

const buildLabTrendExamples = (): EvalExample<
    LabTrendCaseInputs,
    LabTrendCaseOutputs,
    BriefingCaseMetadata
>[] =>
    LAB_TREND_SCENARIOS.map((scenario) => {
        const snapshot = loadUc2Fixture(scenario);
        return {
            inputs: { caseKind: 'lab-trend', snapshot, scenario },
            outputs: labTrendGroundTruth(scenario),
            metadata: { caseKind: 'lab-trend', caseId: `lab-trend:${scenario}` },
        };
    });

const buildMorningPrepExamples = (): EvalExample<
    MorningPrepCaseInputs,
    MorningPrepCaseOutputs,
    BriefingCaseMetadata
>[] => {
    const day = loadUc5MorningPrepDay();
    return day.slots.map((slot) => ({
        inputs: {
            caseKind: 'morning-prep',
            snapshot: slot.snapshot,
            appointmentId: slot.appointmentId,
            practitionerUuid: slot.practitionerUuid,
            startAt: slot.startAt,
            archetype: slot.archetype,
        },
        outputs: { caseKind: 'morning-prep', archetypeFlags: slot.expectedArchetypeFlags },
        metadata: {
            caseKind: 'morning-prep',
            caseId: `morning-prep:${slot.appointmentId}`,
        },
    }));
};

export const buildExamples = (): readonly EvalExample<
    BriefingCaseInputs,
    BriefingCaseOutputs,
    BriefingCaseMetadata
>[] => [
    ...(buildArchetypeExamples() as EvalExample<
        BriefingCaseInputs,
        BriefingCaseOutputs,
        BriefingCaseMetadata
    >[]),
    ...(buildLabTrendExamples() as EvalExample<
        BriefingCaseInputs,
        BriefingCaseOutputs,
        BriefingCaseMetadata
    >[]),
    ...(buildMorningPrepExamples() as EvalExample<
        BriefingCaseInputs,
        BriefingCaseOutputs,
        BriefingCaseMetadata
    >[]),
];

export const uploadDataset = (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> =>
    uploadDatasetGeneric({
        datasetName: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        buildExamples,
        ...options,
    });

const claimToRubricClaim = (claim: Claim): RubricClaim => ({
    text: claim.text,
    category: claim.category,
    sourceReferences: claim.sourceReferences.map((sr) => ({
        source_type: sr.source_type ?? 'unknown',
        source_id: sr.source_id ?? '',
    })),
});

const inferTrendDirection = (acceptedTexts: readonly string[]): 'up' | 'stable' | 'none' => {
    if (acceptedTexts.length === 0) return 'none';
    const joined = acceptedTexts.join(' ').toLowerCase();
    if (joined.includes('up') || joined.includes('rising') || joined.includes('worsen'))
        return 'up';
    if (joined.includes('stable') || joined.includes('unchanged') || joined.includes('flat'))
        return 'stable';
    return 'none';
};

const runExperiment = async (options: {
    readonly anthropicApiKey: string;
    readonly gitSha: string;
}): Promise<ExperimentRunResult> => {
    const synthesizer = createAnthropicSynthesizer({ apiKey: options.anthropicApiKey });

    const target = async (input: BriefingCaseInputs) => {
        const conversationKey =
            input.caseKind === 'archetype'
                ? `exp-${input.archetype}`
                : input.caseKind === 'lab-trend'
                  ? `exp-${input.scenario}`
                  : `exp-${input.appointmentId}`;
        const fhirUser =
            input.caseKind === 'morning-prep'
                ? `https://emr/Practitioner/${input.practitionerUuid}`
                : 'https://emr/Practitioner/experiment';
        const graph = createBriefingGraph({
            retrieveChart: {
                client: buildDatasetSnapshotClient(input.snapshot),
                token: 'experiment',
                siteId: 'default',
            },
            synthesize: { synthesizer },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });
        const out = await graph.invoke({
            envelope: {
                conversationId: conversationKey,
                requestId: conversationKey,
                siteId: 'default',
                actor: { userId: 'experiment', fhirUser },
                patient: { pid: input.snapshot.patient.pid, uuid: input.snapshot.patient.uuid },
                task: 'default_briefing',
            },
        });
        const accepted = out.verified?.accepted ?? [];
        const rejected = out.verified?.rejected ?? [];
        const hardStops = out.verified?.safetyHardStops ?? [];
        const verifierPassed = out.verified?.passed === true;

        const rubricInput: AgentRubricInput = {
            kind: 'briefing',
            acceptedClaims: accepted.map(claimToRubricClaim),
            rejectedClaimCount: rejected.length,
            verifierPassed,
            hardStops,
            schemaValid: null,
            refusalPhraseMatch: null,
            scannedText: accepted.map((c) => c.text),
        };

        const suiteSpecific: Record<string, unknown> = {};
        if (input.caseKind === 'archetype') {
            suiteSpecific['diagnosisCodes'] = accepted
                .filter((c) => c.category === 'diagnosis')
                .map((c) => c.text);
            suiteSpecific['medicationNames'] = accepted
                .filter((c) => c.category === 'prescription')
                .map((c) => c.text);
        } else if (input.caseKind === 'lab-trend') {
            suiteSpecific['trendDirection'] = inferTrendDirection(accepted.map((c) => c.text));
        } else {
            suiteSpecific['archetypeFlags'] = out.formatted?.archetypeFlags ?? [];
        }

        return {
            caseKind: input.caseKind,
            verifierPassed,
            acceptedCount: accepted.length,
            rejectedCount: rejected.length,
            hardStops,
            suiteSpecific,
            rubricInput,
        };
    };

    const results = await evaluate(target, {
        data: DATASET_NAME,
        evaluators: [...RUBRICS],
        experimentPrefix: `briefing-graph-${options.gitSha.slice(0, 7)}`,
        metadata: { git_sha: options.gitSha, suite: 'briefing-graph' },
    });

    return {
        suiteName: 'briefing-graph',
        datasetName: DATASET_NAME,
        experimentName: results.experimentName,
    };
};

export const briefingGraphSuite: EvalSuite = {
    name: 'briefing-graph',
    datasetName: DATASET_NAME,
    uploadDataset,
    runExperiment,
};
