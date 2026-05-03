/**
 * Lab-trends suite — formerly UC2. One fixture per A1c trend
 * scenario (`a1c_trend_up`, `a1c_trend_stable`, `no_lab_history`).
 * Outputs encode the expected verifier verdict for the canonical
 * faithful-model response shape.
 *
 * Live-model target: runs the briefing graph against each fixture
 * and returns the trend direction the synthesizer's accepted claims
 * imply (or `none` when the ledger is empty). LangSmith compares
 * that against the dataset row's `trendDirection` ground truth.
 */

import type { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';

import { createBriefingGraph } from '../../src/graph/index.js';
import { createAnthropicSynthesizer } from '../../src/graph/nodes/synthesize.js';
import type { BriefingSnapshot } from '../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';
import { loadUc2Fixture, type Uc2Scenario } from '../fixtures/load.js';
import { LAB_TREND_SCENARIOS } from '../fixtures/regenerate-lab-trends.js';

import {
    buildDatasetSnapshotClient,
    uploadDatasetGeneric,
    type EvalExample,
    type EvalSuite,
    type ExperimentRunResult,
    type UploadResult,
} from './shared.js';

export const DATASET_NAME = 'clinical-copilot-uc2-trend-v1';

const DATASET_DESCRIPTION =
    'UC2 (lab/vitals trend) — one fixture per trend scenario (a1c_trend_up, a1c_trend_stable, no_lab_history). Inputs are the BriefingSnapshot whose `labHistory` slot is populated; outputs encode the expected verifier verdict (passes/redacts/no-claims) for the canonical faithful-model response shape.';

interface LabTrendOutputs {
    readonly trendDirection: 'up' | 'stable' | 'none';
    readonly expectedAccept: boolean;
}

interface LabTrendInputs {
    readonly snapshot: BriefingSnapshot;
    readonly scenario: Uc2Scenario;
}

const groundTruth = (scenario: Uc2Scenario): LabTrendOutputs => {
    switch (scenario) {
        case 'a1c_trend_up':
            return { trendDirection: 'up', expectedAccept: true };
        case 'a1c_trend_stable':
            return { trendDirection: 'stable', expectedAccept: true };
        case 'no_lab_history':
            // Faithful model emits a no-data acknowledgement (empty
            // ledger). No claims to accept; turn passes through.
            return { trendDirection: 'none', expectedAccept: true };
    }
};

export const buildExamples = (): readonly EvalExample<
    LabTrendInputs,
    LabTrendOutputs,
    { scenario: Uc2Scenario }
>[] =>
    LAB_TREND_SCENARIOS.map((scenario) => {
        const snapshot = loadUc2Fixture(scenario);
        return {
            inputs: { snapshot, scenario },
            outputs: groundTruth(scenario),
            metadata: { scenario },
        };
    });

export const uploadDataset = (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> =>
    uploadDatasetGeneric({
        datasetName: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        buildExamples,
        ...options,
    });

/**
 * Infer the trend direction implied by the verifier's accepted
 * claims. The synthesizer is expected to emit a single
 * `lab_trend_summary` claim whose text encodes the direction; the
 * dataset comparison is forgiving — it just looks for "up", "stable",
 * or no claim at all.
 */
const inferTrendDirection = (acceptedTexts: readonly string[]): 'up' | 'stable' | 'none' => {
    if (acceptedTexts.length === 0) {
        return 'none';
    }
    const joined = acceptedTexts.join(' ').toLowerCase();
    if (joined.includes('up') || joined.includes('rising') || joined.includes('worsen')) {
        return 'up';
    }
    if (joined.includes('stable') || joined.includes('unchanged') || joined.includes('flat')) {
        return 'stable';
    }
    return 'none';
};

const runExperiment = async (
    options: { readonly anthropicApiKey: string; readonly gitSha: string },
): Promise<ExperimentRunResult> => {
    const synthesizer = createAnthropicSynthesizer({ apiKey: options.anthropicApiKey });

    const target = async (input: LabTrendInputs) => {
        const graph = createBriefingGraph({
            retrieve: {
                client: buildDatasetSnapshotClient(input.snapshot),
                token: 'experiment',
                siteId: 'default',
            },
            synthesize: { synthesizer },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });
        const out = await graph.invoke({
            envelope: {
                conversationId: `exp-${input.scenario}`,
                requestId: `exp-${input.scenario}`,
                siteId: 'default',
                actor: { userId: 'experiment', fhirUser: 'https://emr/Practitioner/experiment' },
                patient: { pid: input.snapshot.patient.pid, uuid: input.snapshot.patient.uuid },
                task: 'default_briefing',
            },
        });
        const accepted = out.verified?.accepted ?? [];
        const trendDirection = inferTrendDirection(accepted.map((c) => c.text));
        return {
            verifierPassed: out.verified?.passed === true,
            acceptedCount: accepted.length,
            trendDirection,
            hardStops: out.verified?.safetyHardStops ?? [],
        };
    };

    const results = await evaluate(target, {
        data: DATASET_NAME,
        experimentPrefix: `lab-trends-${options.gitSha.slice(0, 7)}`,
        metadata: { git_sha: options.gitSha, suite: 'lab-trends' },
    });

    return {
        suiteName: 'lab-trends',
        datasetName: DATASET_NAME,
        experimentName: results.experimentName,
    };
};

export const labTrendsSuite: EvalSuite = {
    name: 'lab-trends',
    datasetName: DATASET_NAME,
    uploadDataset,
    runExperiment,
};
