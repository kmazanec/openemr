/**
 * Shared types and helpers for the LangSmith runner suite registry.
 * Each eval suite (archetypes, lab-trends, morning-prep) owns its
 * dataset shape and live-model target via an `EvalSuite` entry; the
 * CLI and experiment runner iterate the registry rather than knowing
 * about individual suites.
 */

import { Client } from 'langsmith';

import type { BriefingSnapshot } from '../../src/graph/types.js';
import type { ChartSnapshot, Encounter, LabObservation } from '../../src/snapshot/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';

export interface UploadResult {
    readonly created: boolean;
    readonly datasetName: string;
    readonly exampleCount: number;
    readonly skippedReason?: string;
}

export interface ExperimentRunResult {
    readonly suiteName: string;
    readonly datasetName: string;
    readonly experimentName?: string;
    readonly skippedReason?: string;
}

/**
 * Generic example shape: each suite defines its own input + output
 * types but they all flow through `Client.createExamples` the same
 * way. The `unknown` typed generics defer the `KVMap` constraint
 * check to the createExamples call site (cast there); per-suite
 * modules keep their concrete types internally.
 */
export interface EvalExample<I, O, M> {
    readonly inputs: I;
    readonly outputs: O;
    readonly metadata: M;
}

/**
 * One eval suite. `runTarget` returns whatever LangSmith should
 * record as the experiment row's output; the dataset's `outputs`
 * field is what it's compared against in the LangSmith UI.
 */
export interface EvalSuite {
    readonly name: string;
    readonly datasetName: string;
    readonly uploadDataset: (
        options?: { readonly client?: Client; readonly apiKey?: string },
    ) => Promise<UploadResult>;
    /**
     * Run the live-model experiment for this suite against
     * `datasetName`. Returns the LangSmith experiment name on
     * success, or a `skippedReason` if the suite cannot run (e.g.
     * required env vars missing — though the top-level runner
     * filters those out before calling).
     */
    readonly runExperiment: (
        options: { readonly anthropicApiKey: string; readonly gitSha: string },
    ) => Promise<ExperimentRunResult>;
}

/**
 * Generic uploader: wraps the "skip-if-no-key, skip-if-exists,
 * create+populate" pattern that every suite shares. Each suite
 * passes its dataset name, description, and a thunk that builds the
 * example list lazily (so we don't load fixtures when the upload
 * skips).
 */
export const uploadDatasetGeneric = async <I, O, M>(
    options: {
        readonly datasetName: string;
        readonly description: string;
        readonly buildExamples: () => readonly EvalExample<I, O, M>[];
        readonly client?: Client;
        readonly apiKey?: string;
    },
): Promise<UploadResult> => {
    const apiKey = options.apiKey ?? process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        return {
            created: false,
            datasetName: options.datasetName,
            exampleCount: 0,
            skippedReason: 'LANGSMITH_API_KEY not set',
        };
    }

    const client = options.client ?? new Client({ apiKey });

    const exists = await client.hasDataset({ datasetName: options.datasetName });
    if (exists) {
        return {
            created: false,
            datasetName: options.datasetName,
            exampleCount: 0,
            skippedReason: 'dataset already exists',
        };
    }

    const dataset = await client.createDataset(options.datasetName, {
        description: options.description,
        dataType: 'kv',
    });

    const examples = options.buildExamples().map((ex) => ({
        inputs: ex.inputs,
        outputs: ex.outputs,
        metadata: ex.metadata,
        dataset_id: dataset.id,
    }));

    // The langsmith client constrains `inputs`/`outputs`/`metadata`
    // to `KVMap` (Record<string, any>), but generic per-suite types
    // can't satisfy that constraint without leaking the KVMap
    // requirement upward. The runtime shape is correct — every
    // suite's example types are object-shaped. Cast at the boundary.
    await client.createExamples(examples as Parameters<Client['createExamples']>[0]);
    return {
        created: true,
        datasetName: options.datasetName,
        exampleCount: examples.length,
    };
};

/**
 * Snapshot client that resolves from a closed-over fixture instead
 * of HTTPing OpenEMR. Used by every suite's experiment target so
 * the briefing graph reads the dataset row's snapshot rather than
 * the live EMR. The `BriefingSnapshot → ChartSnapshot` narrowing
 * mirrors the previous experiment runner: the bulk endpoint never
 * returns labs/encounters as a Gap, so array-shaped fixtures pass
 * straight through.
 */
export const buildDatasetSnapshotClient = (snapshot: BriefingSnapshot): SnapshotClient => {
    const chart: ChartSnapshot = {
        patient: snapshot.patient,
        appointment: snapshot.appointment,
        diagnoses: snapshot.diagnoses,
        prescriptions: snapshot.prescriptions,
        allergies: snapshot.allergies,
        labs: Array.isArray(snapshot.labs) ? snapshot.labs : ([] as readonly LabObservation[]),
        encounters: Array.isArray(snapshot.encounters)
            ? snapshot.encounters
            : ([] as readonly Encounter[]),
        reminders: Array.isArray(snapshot.reminders) ? snapshot.reminders : [],
        medications: Array.isArray(snapshot.medications) ? snapshot.medications : [],
    };
    return {
        fetchSnapshot: () => Promise.resolve(chart),
    };
};
