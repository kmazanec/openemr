/**
 * Morning-prep suite — formerly UC5. One example per slot in the
 * synthetic 20-patient day fixture; outputs encode the
 * `archetypeFlags` `deriveArchetypeFlags()` should produce for that
 * slot. The flagged subset is 8 of 20 (3 diabetic_uncontrolled,
 * 3 complex_elderly_new_med, 2 recent_ed_visit).
 *
 * Live-model target: runs the briefing graph against each slot and
 * returns the `archetypeFlags` the graph computed (these are
 * deterministic from the snapshot, but routing them through the
 * live graph lets the experiment also catch synthesizer-side
 * regressions that cause the format step to fail).
 */

import type { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';

import { createBriefingGraph } from '../../src/graph/index.js';
import { createAnthropicSynthesizer } from '../../src/graph/nodes/synthesize.js';
import type { BriefingSnapshot } from '../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';
import { loadUc5MorningPrepDay, type Uc5LoadedSlot } from '../fixtures/load.js';

import {
    buildDatasetSnapshotClient,
    uploadDatasetGeneric,
    type EvalExample,
    type EvalSuite,
    type ExperimentRunResult,
    type UploadResult,
} from './shared.js';

export const DATASET_NAME = 'clinical-copilot-uc5-morning-prep-v2';

const DATASET_DESCRIPTION =
    'UC5 (schedule-aware morning prep) — one example per slot in the synthetic 20-patient day fixture. Inputs are the slot snapshot + appointment metadata; outputs encode the expected `archetypeFlags` deriveArchetypeFlags() should produce for that slot (e.g. `archetype:diabetic_uncontrolled`). The flagged subset is 8 of 20 (3 diabetic_uncontrolled, 3 complex_elderly_new_med, 2 recent_ed_visit). Bumping the example shape means renaming this constant to `…-v2`; old experiments stay comparable.';

interface MorningPrepInputs {
    readonly snapshot: BriefingSnapshot;
    readonly appointmentId: string;
    readonly practitionerUuid: string;
    readonly startAt: string;
    readonly archetype: string;
}

interface MorningPrepOutputs {
    readonly archetypeFlags: readonly string[];
}

interface MorningPrepMetadata {
    readonly archetype: string;
    readonly appointmentId: string;
}

export const buildExamples = (): readonly EvalExample<
    MorningPrepInputs,
    MorningPrepOutputs,
    MorningPrepMetadata
>[] => {
    const day = loadUc5MorningPrepDay();
    return day.slots.map((slot: Uc5LoadedSlot) => ({
        inputs: {
            snapshot: slot.snapshot,
            appointmentId: slot.appointmentId,
            practitionerUuid: slot.practitionerUuid,
            startAt: slot.startAt,
            archetype: slot.archetype,
        },
        outputs: { archetypeFlags: slot.expectedArchetypeFlags },
        metadata: { archetype: slot.archetype, appointmentId: slot.appointmentId },
    }));
};

export const uploadDataset = (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> =>
    uploadDatasetGeneric({
        datasetName: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        buildExamples,
        ...options,
    });

const runExperiment = async (
    options: { readonly anthropicApiKey: string; readonly gitSha: string },
): Promise<ExperimentRunResult> => {
    const synthesizer = createAnthropicSynthesizer({ apiKey: options.anthropicApiKey });

    const target = async (input: MorningPrepInputs) => {
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
                conversationId: `exp-${input.appointmentId}`,
                requestId: `exp-${input.appointmentId}`,
                siteId: 'default',
                actor: {
                    userId: 'experiment',
                    fhirUser: `https://emr/Practitioner/${input.practitionerUuid}`,
                },
                patient: { pid: input.snapshot.patient.pid, uuid: input.snapshot.patient.uuid },
                task: 'default_briefing',
            },
        });
        return {
            verifierPassed: out.verified?.passed === true,
            archetypeFlags: out.formatted?.archetypeFlags ?? [],
            hardStops: out.verified?.safetyHardStops ?? [],
        };
    };

    const results = await evaluate(target, {
        data: DATASET_NAME,
        experimentPrefix: `morning-prep-${options.gitSha.slice(0, 7)}`,
        metadata: { git_sha: options.gitSha, suite: 'morning-prep' },
    });

    return {
        suiteName: 'morning-prep',
        datasetName: DATASET_NAME,
        experimentName: results.experimentName,
    };
};

export const morningPrepSuite: EvalSuite = {
    name: 'morning-prep',
    datasetName: DATASET_NAME,
    uploadDataset,
    runExperiment,
};
