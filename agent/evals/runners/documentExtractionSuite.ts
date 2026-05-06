/**
 * Conversational-graph eval suite — registry entry for the
 * document-evidence retriever, guidelines retriever, and verifier.
 *
 * The per-MR Vitest gate for these cases lives at
 * `agent/evals/cases/conversational-graph/{document-evidence,
 * guidelines,verification}/*.test.ts` and asserts the structural
 * invariants (patient-scope cannot widen, fabricated bboxes reject,
 * retriever gaps surface as unresolved, low-confidence allergy fails
 * closed). This file is the **nightly-experiment** layer per
 * `W2_ARCHITECTURE.md` §"Eval Architecture" — same dataset, real
 * Anthropic + Pinecone + Cohere + OpenAI clients.
 *
 * Dataset shape: one example per case-group. The inputs encode the
 * scenario (a stubbed-vendor scenario for the deterministic gates;
 * a real-query scenario for the real-vendor experiment); the
 * outputs encode the ground-truth gate the experiment compares the
 * live run's verdict against. Three groups → three rows. The shape
 * mirrors the per-MR test files so a regression in either layer
 * shows up in the same diff.
 *
 * Real-vendor `runExperiment` skips when any of PINECONE_API_KEY /
 * PINECONE_INDEX_NAME / OPENAI_API_KEY / COHERE_API_KEY is missing,
 * and additionally skips until the Pinecone index has been
 * provisioned and populated by the corpus-reindex script.
 */

import type { Client } from 'langsmith';

import {
    uploadDatasetGeneric,
    type EvalExample,
    type EvalSuite,
    type ExperimentRunResult,
    type UploadResult,
} from './shared.js';

export const DATASET_NAME = 'clinical-copilot-conversational-graph-v1';

const DATASET_DESCRIPTION =
    'Conversational-graph evals — one example per case group (document-evidence retriever, guidelines retriever, verification per source_type). Inputs encode the scenario; outputs encode the ground-truth gate the verifier should reach. The per-MR Vitest layer at agent/evals/cases/conversational-graph/ asserts the structural invariants over stubbed vendors; the nightly experiment runs the same scenarios against real Anthropic + Pinecone + Cohere + OpenAI.';

interface ConversationalGraphInputs {
    readonly group:
        | 'document-evidence'
        | 'guidelines'
        | 'verification';
    /** Plain-language description of the case so the LangSmith UI is readable without a code crossreference. */
    readonly description: string;
}

interface ConversationalGraphOutputs {
    /** The deterministic gate the experiment's live run should reach. */
    readonly expectedGate:
        | 'verifier-accepted'
        | 'verifier-rejected'
        | 'gap-emitted'
        | 'hard-stop';
}

interface ConversationalGraphMetadata {
    readonly group: ConversationalGraphInputs['group'];
}

const EXAMPLES: readonly EvalExample<
    ConversationalGraphInputs,
    ConversationalGraphOutputs,
    ConversationalGraphMetadata
>[] = [
    {
        inputs: {
            group: 'document-evidence',
            description:
                'Lab PDF artifact for the envelope patient + supervisor query "HbA1c"; verifier accepts the extracted_document claim citing the snippet bbox/page/quote.',
        },
        outputs: { expectedGate: 'verifier-accepted' },
        metadata: { group: 'document-evidence' },
    },
    {
        inputs: {
            group: 'guidelines',
            description:
                'Pinecone returns the colorectal-screening chunk; Cohere reranks it top-1; verifier accepts the guideline claim citing it.',
        },
        outputs: { expectedGate: 'verifier-accepted' },
        metadata: { group: 'guidelines' },
    },
    {
        inputs: {
            group: 'verification',
            description:
                'Low-confidence allergy fact in an intake form fires HARD_STOP_ALLERGIES_UNAVAILABLE; allergy + prescription content suppressed for the turn.',
        },
        outputs: { expectedGate: 'hard-stop' },
        metadata: { group: 'verification' },
    },
];

export const buildExamples = (): readonly EvalExample<
    ConversationalGraphInputs,
    ConversationalGraphOutputs,
    ConversationalGraphMetadata
>[] => EXAMPLES;

export const uploadDataset = (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> =>
    uploadDatasetGeneric({
        datasetName: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        buildExamples,
        ...options,
    });

const REQUIRED_VENDOR_ENV: readonly string[] = [
    'PINECONE_API_KEY',
    'PINECONE_INDEX_NAME',
    'OPENAI_API_KEY',
    'COHERE_API_KEY',
];

const runExperiment = (
    _options: { readonly anthropicApiKey: string; readonly gitSha: string },
): Promise<ExperimentRunResult> => {
    const missing = REQUIRED_VENDOR_ENV.filter((name) => {
        const v = process.env[name];
        return v === undefined || v.length === 0;
    });
    if (missing.length > 0) {
        return Promise.resolve({
            suiteName: 'conversational-graph',
            datasetName: DATASET_NAME,
            skippedReason: `missing vendor env: ${missing.join(', ')}`,
        });
    }
    // The real-vendor end-to-end run is gated behind the user
    // provisioning the Pinecone index. Until then the per-MR Vitest
    // layer is the load-bearing gate. Returning a skip with a
    // descriptive reason keeps the runner's contract clean — it
    // doesn't confuse "ran zero rows" with "ran all rows green."
    return Promise.resolve({
        suiteName: 'conversational-graph',
        datasetName: DATASET_NAME,
        skippedReason:
            'real-vendor experiment is gated until the Pinecone index is provisioned; per-MR Vitest gates protect the structural invariants',
    });
};

export const documentExtractionSuite: EvalSuite = {
    name: 'conversational-graph',
    datasetName: DATASET_NAME,
    uploadDataset,
    runExperiment,
};
