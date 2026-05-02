/**
 * §3.6 LangSmith dataset uploader. Pushes the canonical archetype
 * fixtures into the `clinical-copilot-uc1-golden-v1` dataset so the
 * §6.1 LangSmith eval workflow can run experiments against the same
 * golden set our local Vitest cases use.
 *
 * Idempotency: a dataset that already exists is left alone. The
 * uploader is a one-shot bootstrap, not a sync — re-running it is a
 * no-op. Re-creating the dataset (after a schema change) means
 * deleting it on the LangSmith side first.
 *
 * No-op when LANGSMITH_API_KEY is unset, so the agent's `npm test` and
 * the host-side phpunit-isolated suite never reach LangSmith. CI's
 * `test:agent-evals` job sets the env var explicitly.
 */

import { Client } from 'langsmith';

import type { ChartSnapshot } from '../../src/snapshot/types.js';
import { loadFixture } from '../fixtures/load.js';
import { ARCHETYPES, type ArchetypeKey } from '../fixtures/regenerate.js';

export const DATASET_NAME = 'clinical-copilot-uc1-golden-v1';
const DATASET_DESCRIPTION =
    'UC1 default pre-visit briefing — one canonical ChartSnapshot per archetype declared in PatientArchetype.php. Inputs are the snapshot; outputs encode archetype-pinned ground truth (diagnosis codes, medication names) the verifier must surface.';

interface UploadResult {
    readonly created: boolean;
    readonly datasetName: string;
    readonly exampleCount: number;
    readonly skippedReason?: string;
}

/**
 * Returns the archetype-pinned ground truth used as the dataset's
 * `outputs` field. Mirrors the table in `archetypes.test.ts`.
 */
const groundTruth = (archetype: ArchetypeKey): {
    readonly diagnosisCodes: readonly string[];
    readonly medicationNames: readonly string[];
} => {
    switch (archetype) {
        case 'healthy_adult':
            return { diagnosisCodes: [], medicationNames: [] };
        case 'hypertensive':
            return { diagnosisCodes: ['I10'], medicationNames: ['Lisinopril'] };
        case 'diabetic':
            return { diagnosisCodes: ['E11.9'], medicationNames: ['Metformin'] };
        case 'diabetic_uncontrolled':
            return {
                diagnosisCodes: ['E11.9'],
                medicationNames: ['Metformin', 'Lisinopril'],
            };
        case 'complex_elderly':
            return {
                diagnosisCodes: ['I10', 'E78.5', 'M19.90'],
                medicationNames: ['Lisinopril', 'Atorvastatin'],
            };
        case 'recent_ed_visit':
            return { diagnosisCodes: [], medicationNames: [] };
    }
};

const buildExamples = (): readonly {
    inputs: { snapshot: ChartSnapshot; archetype: ArchetypeKey };
    outputs: { diagnosisCodes: readonly string[]; medicationNames: readonly string[] };
    metadata: { archetype: ArchetypeKey };
}[] =>
    ARCHETYPES.map((archetype) => {
        const snapshot = loadFixture(archetype);
        return {
            inputs: { snapshot, archetype },
            outputs: groundTruth(archetype),
            metadata: { archetype },
        };
    });

export const uploadDataset = async (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> => {
    const apiKey = options.apiKey ?? process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        return {
            created: false,
            datasetName: DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'LANGSMITH_API_KEY not set',
        };
    }

    const client = options.client ?? new Client({ apiKey });

    const exists = await client.hasDataset({ datasetName: DATASET_NAME });
    if (exists) {
        return {
            created: false,
            datasetName: DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'dataset already exists',
        };
    }

    const dataset = await client.createDataset(DATASET_NAME, {
        description: DATASET_DESCRIPTION,
        dataType: 'kv',
    });

    const examples = buildExamples().map((ex) => ({
        inputs: ex.inputs,
        outputs: ex.outputs,
        metadata: ex.metadata,
        dataset_id: dataset.id,
    }));

    await client.createExamples(examples);
    return {
        created: true,
        datasetName: DATASET_NAME,
        exampleCount: examples.length,
    };
};
