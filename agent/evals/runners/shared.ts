/**
 * Shared types and helpers for the LangSmith runner suite registry.
 * Each eval suite (archetypes, lab-trends, morning-prep) owns its
 * dataset shape and live-model target via an `EvalSuite` entry; the
 * CLI and experiment runner iterate the registry rather than knowing
 * about individual suites.
 */

import { Client } from 'langsmith';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

import type { EvidenceRetrieverDeps } from '../../src/graph/nodes/evidenceRetriever.js';
import type { BriefingSnapshot } from '../../src/graph/types.js';
import { createLogger } from '../../src/observability/logger.js';
import { createCohereRerankClient } from '../../src/retrievers/cohere.js';
import { loadCorpusBM25Stats } from '../../src/retrievers/corpusLoader.js';
import { createPineconeRetriever } from '../../src/retrievers/pinecone.js';
import type { ChartSnapshot } from '../../src/snapshot/types.js';
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
 * Coerce a decoded id (`string | null`) back to the bulk endpoint's
 * wire shape (`number | null`). Production `loadChartSnapshot`
 * always re-decodes whatever its `fetchSnapshot` returns, so eval
 * datasets must hand it wire-shape ids regardless of how the fixture
 * was loaded — the morning-prep loader pre-decodes ids to string,
 * the archetypes loader doesn't.
 */
const toWireId = (id: unknown): number | null => {
    if (id === null || id === undefined) {
        return null;
    }
    if (typeof id === 'number' && Number.isInteger(id)) {
        return id;
    }
    if (typeof id === 'string') {
        const n = Number.parseInt(id, 10);
        return Number.isFinite(n) ? n : null;
    }
    return null;
};

/**
 * Snapshot client that resolves from a closed-over fixture instead
 * of HTTPing OpenEMR. Used by every suite's experiment target so
 * the briefing graph reads the dataset row's snapshot rather than
 * the live EMR.
 *
 * Returns wire-shape JSON (id fields as integers) because
 * `loadChartSnapshot` always pipes the fetched value back through
 * `decodeChartSnapshot`. Some suites' uploaders store snapshots
 * with already-decoded ids (`prescriptionId: "22001"`); the wire
 * coercion below makes this client work with either shape.
 */
export const buildDatasetSnapshotClient = (snapshot: BriefingSnapshot): SnapshotClient => {
    const rewireId = <K extends string>(items: readonly unknown[], idKey: K): unknown[] =>
        items.map((item) => {
            const obj = item as Record<string, unknown>;
            return { ...obj, [idKey]: toWireId(obj[idKey]) };
        });
    const prescriptions = rewireId(snapshot.prescriptions ?? [], 'prescriptionId');
    const reminders = Array.isArray(snapshot.reminders)
        ? rewireId(snapshot.reminders, 'reminderId')
        : [];
    const medications = Array.isArray(snapshot.medications)
        ? rewireId(snapshot.medications, 'listId')
        : [];
    const wire = {
        patient: snapshot.patient,
        appointment: snapshot.appointment,
        diagnoses: snapshot.diagnoses,
        prescriptions,
        allergies: snapshot.allergies,
        labs: Array.isArray(snapshot.labs) ? snapshot.labs : [],
        encounters: Array.isArray(snapshot.encounters) ? snapshot.encounters : [],
        reminders,
        medications,
    };
    // `loadChartSnapshot` decodes the fetched value; the Chart cast
    // is a lie at this boundary (ids are integers, not strings) but
    // immediately corrected by `decodeChartSnapshot`. Casting here is
    // simpler than threading a wire-shape DTO type the rest of the
    // codebase doesn't use.
    return {
        fetchSnapshot: () => Promise.resolve(wire as unknown as ChartSnapshot),
    };
};

/**
 * Boot the Pinecone+Cohere `EvidenceRetrieverDeps` used by the
 * `conversational-graph` suite. Returns null when
 * any of the required env vars (`OPENAI_API_KEY`, `PINECONE_API_KEY`,
 * `PINECONE_INDEX_NAME`, `COHERE_API_KEY`) is missing — callers run
 * the experiment without the retriever, which surfaces as a verdict
 * mismatch on dataset rows that legitimately need guideline
 * retrieval. Mirrors `agent/src/server/briefingRunner.ts`'s
 * production builder so the eval target sees the same retriever
 * shape the deployed app does.
 *
 * The `loggerName` is the suite's name so log lines are attributable
 * to a specific suite when multiple boot in one experiment run.
 */
export const buildEvidenceRetrieverDepsFromEnv = async (
    loggerName: string,
): Promise<EvidenceRetrieverDeps | null> => {
    const logger = createLogger(loggerName);
    const openaiKey = process.env['OPENAI_API_KEY'] ?? '';
    const pineconeKey = process.env['PINECONE_API_KEY'] ?? '';
    const indexName = process.env['PINECONE_INDEX_NAME'] ?? '';
    const cohereKey = process.env['COHERE_API_KEY'] ?? '';
    const namespace = process.env['PINECONE_NAMESPACE'] ?? 'guidelines-v1';

    const missing: string[] = [];
    if (openaiKey.length === 0) missing.push('OPENAI_API_KEY');
    if (pineconeKey.length === 0) missing.push('PINECONE_API_KEY');
    if (indexName.length === 0) missing.push('PINECONE_INDEX_NAME');
    if (cohereKey.length === 0) missing.push('COHERE_API_KEY');
    if (missing.length > 0) {
        logger.warn(
            { missing },
            'evidenceRetriever deps not wired — guideline-shaped rows will mismatch the dataset expectation',
        );
        return null;
    }

    const { stats, chunkCount } = await loadCorpusBM25Stats();
    if (chunkCount === 0) {
        logger.warn(
            'evidenceRetriever corpus is empty — run npm run grounding:reindex-corpus first',
        );
    }

    const openai = new OpenAI({ apiKey: openaiKey });
    const pinecone = new Pinecone({ apiKey: pineconeKey });
    const pineconeRetriever = createPineconeRetriever({
        pinecone,
        indexName,
        namespace,
        embeddings: openai.embeddings,
        bm25Stats: stats,
    });
    const cohereRerank = createCohereRerankClient({ apiKey: cohereKey });
    return { pineconeRetriever, cohereRerank };
};
