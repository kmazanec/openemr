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

import type { BriefingSnapshot } from '../../src/graph/types.js';
import { loadFixture, loadUc2Fixture, type Uc2Scenario } from '../fixtures/load.js';
import { ARCHETYPES, type ArchetypeKey } from '../fixtures/regenerate.js';
import { UC2_SCENARIOS } from '../fixtures/regenerate-uc2.js';

export const DATASET_NAME = 'clinical-copilot-uc1-golden-v2';
const DATASET_DESCRIPTION =
    'UC1 default pre-visit briefing — one canonical ChartSnapshot per archetype declared in PatientArchetype.php. Inputs are the snapshot; outputs encode archetype-pinned ground truth (diagnosis codes, medication names, ccda-importer encounter ids the §4.1 follow-up generator should surface as external_care suggestions) the verifier must surface.';

interface UploadResult {
    readonly created: boolean;
    readonly datasetName: string;
    readonly exampleCount: number;
    readonly skippedReason?: string;
}

/**
 * Returns the archetype-pinned ground truth used as the dataset's
 * `outputs` field. Mirrors the table in `archetypes.test.ts`.
 *
 * `externalEncounterIds` is the §4.4 UC4 contract: the recordIds of
 * any `system: 'ccda-importer'` encounters in the fixture. The
 * §4.1 follow-ups generator must surface an `external_care`
 * suggestion grounded in at least one of these claims; the LangSmith
 * eval scores the real-model run on whether it both renders the
 * suggestion and accepts a follow-up claim citing one of the listed
 * recordIds.
 */
const groundTruth = (archetype: ArchetypeKey): {
    readonly diagnosisCodes: readonly string[];
    readonly medicationNames: readonly string[];
    readonly externalEncounterIds: readonly string[];
} => {
    switch (archetype) {
        case 'healthy_adult':
            return { diagnosisCodes: [], medicationNames: [], externalEncounterIds: [] };
        case 'hypertensive':
            return {
                diagnosisCodes: ['I10'],
                medicationNames: ['Lisinopril'],
                externalEncounterIds: [],
            };
        case 'diabetic':
            return {
                diagnosisCodes: ['E11.9'],
                medicationNames: ['Metformin'],
                externalEncounterIds: [],
            };
        case 'diabetic_uncontrolled':
            return {
                diagnosisCodes: ['E11.9'],
                medicationNames: ['Metformin', 'Lisinopril'],
                externalEncounterIds: [],
            };
        case 'complex_elderly':
            return {
                diagnosisCodes: ['I10', 'E78.5', 'M19.90'],
                medicationNames: ['Lisinopril', 'Atorvastatin'],
                externalEncounterIds: [],
            };
        case 'recent_ed_visit':
            return {
                diagnosisCodes: [],
                medicationNames: [],
                externalEncounterIds: ['enc-6006-ed'],
            };
    }
};

const buildExamples = (): readonly {
    inputs: { snapshot: BriefingSnapshot; archetype: ArchetypeKey };
    outputs: {
        diagnosisCodes: readonly string[];
        medicationNames: readonly string[];
        externalEncounterIds: readonly string[];
    };
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

// ---------------------------------------------------------------------
// §4.2 UC2 lab-trend dataset
// ---------------------------------------------------------------------

export const UC2_DATASET_NAME = 'clinical-copilot-uc2-trend-v1';

const UC2_DATASET_DESCRIPTION =
    'UC2 (lab/vitals trend) — one fixture per trend scenario (a1c_trend_up, a1c_trend_stable, no_lab_history). Inputs are the BriefingSnapshot whose `labHistory` slot is populated; outputs encode the expected verifier verdict (passes/redacts/no-claims) for the canonical faithful-model response shape.';

/**
 * Per-scenario ground truth: what should happen when a faithful
 * model emits a single trend-shaped claim citing every history row.
 * The Vitest gate exercises adversarial cases too; this dataset
 * captures the happy path so the nightly LangSmith experiment can
 * compare a real model run against the same expectation.
 */
const uc2GroundTruth = (scenario: Uc2Scenario): {
    readonly trendDirection: 'up' | 'stable' | 'none';
    readonly expectedAccept: boolean;
} => {
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

const buildUc2Examples = (): readonly {
    inputs: { snapshot: BriefingSnapshot; scenario: Uc2Scenario };
    outputs: { trendDirection: 'up' | 'stable' | 'none'; expectedAccept: boolean };
    metadata: { scenario: Uc2Scenario };
}[] =>
    UC2_SCENARIOS.map((scenario) => {
        const snapshot = loadUc2Fixture(scenario);
        return {
            inputs: { snapshot, scenario },
            outputs: uc2GroundTruth(scenario),
            metadata: { scenario },
        };
    });

export const uploadUc2Dataset = async (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> => {
    const apiKey = options.apiKey ?? process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        return {
            created: false,
            datasetName: UC2_DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'LANGSMITH_API_KEY not set',
        };
    }

    const client = options.client ?? new Client({ apiKey });

    const exists = await client.hasDataset({ datasetName: UC2_DATASET_NAME });
    if (exists) {
        return {
            created: false,
            datasetName: UC2_DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'dataset already exists',
        };
    }

    const dataset = await client.createDataset(UC2_DATASET_NAME, {
        description: UC2_DATASET_DESCRIPTION,
        dataType: 'kv',
    });

    const examples = buildUc2Examples().map((ex) => ({
        inputs: ex.inputs,
        outputs: ex.outputs,
        metadata: ex.metadata,
        dataset_id: dataset.id,
    }));

    await client.createExamples(examples);
    return {
        created: true,
        datasetName: UC2_DATASET_NAME,
        exampleCount: examples.length,
    };
};
