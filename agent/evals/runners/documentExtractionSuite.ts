/**
 * §B.10 document-extraction eval suite — registry entry for the 26
 * pipeline cases (8 lab PDF + 8 intake form + 6 degraded + 4
 * adversarial).
 *
 * The per-MR Vitest gate at
 * `agent/evals/cases/document-extraction/{lab-pdf,intake-form,
 * degraded,adversarial}/*.test.ts` runs every case through
 * `runDocumentExtractionCase` with the stub vision invoker; this
 * proves the structural invariants (status routing, error-code
 * mapping, citation presence, cost-cap pre-flight, cleanup) without
 * spending on a real Anthropic call.
 *
 * The LangSmith experiment runs the same case set against the real
 * Anthropic vision client (`createAnthropicVisionInvocation`). The
 * shape of each example mirrors what the per-MR gate asserts so the
 * two layers stay aligned: a regression in either surface shows up
 * in the same diff.
 *
 * Dataset shape: one example per case. Bumping the shape (adding a
 * new manifest field that flows to the LangSmith row, or changing
 * the rubric) means renaming `DATASET_NAME` from `-v1` to `-v2` so
 * old experiments stay comparable.
 */

import type { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';

import {
    type ManifestEntry,
} from '../fixtures/regenerate-document-extraction.js';
import {
    loadEntries,
} from './documentExtractionFixtures.js';
import {
    buildExperimentVisionInvoker,
    runDocumentExtractionCase,
    type CaseRunResult,
} from './documentExtractionTarget.js';
import {
    uploadDatasetGeneric,
    type EvalExample,
    type EvalSuite,
    type ExperimentRunResult,
    type UploadResult,
} from './shared.js';

export const DATASET_NAME = 'clinical-copilot-document-extraction-v1';

const DATASET_DESCRIPTION =
    'Document-extraction pipeline evals - 26 cases (8 lab PDF + 8 intake form + 6 degraded + 4 adversarial). Inputs encode the manifest entry; outputs encode expectedStatus + expectedErrorCode the pipeline must reach. The per-MR Vitest layer runs the same case set with the stub vision invoker (deterministic); the nightly experiment runs against real Anthropic Sonnet 4.x. Bump DATASET_NAME from -v1 when the input/output shape changes so prior experiments stay comparable.';

interface DocumentExtractionInputs {
    readonly caseId: string;
    readonly caseKind: string;
    readonly docType: 'lab_pdf' | 'intake_form';
    readonly archetype: string;
    /** Plain-language description so the LangSmith UI is readable without a code crossreference. */
    readonly description: string;
}

interface DocumentExtractionOutputs {
    readonly expectedStatus: 'persisted' | 'failed';
    readonly expectedErrorCode: string | null;
}

interface DocumentExtractionMetadata {
    readonly caseKind: string;
    readonly archetype: string;
}

const buildExample = (
    entry: ManifestEntry,
): EvalExample<
    DocumentExtractionInputs,
    DocumentExtractionOutputs,
    DocumentExtractionMetadata
> => ({
    inputs: {
        caseId: entry.id,
        caseKind: entry.caseKind,
        docType: entry.docType,
        archetype: entry.patient.archetype,
        description: entry.notes,
    },
    outputs: {
        expectedStatus: entry.expectedStatus,
        expectedErrorCode: entry.expectedErrorCode ?? null,
    },
    metadata: {
        caseKind: entry.caseKind,
        archetype: entry.patient.archetype,
    },
});

/**
 * Build the LangSmith examples list. Returned as a Promise because
 * loading the manifest is async; the generic uploader's
 * `buildExamples` thunk supports sync return only, so we resolve once
 * and snapshot the result before passing it through.
 */
export const buildExamples = async (): Promise<
    readonly EvalExample<
        DocumentExtractionInputs,
        DocumentExtractionOutputs,
        DocumentExtractionMetadata
    >[]
> => {
    const entries = await loadEntries();
    return entries.map((entry) => buildExample(entry));
};

export const uploadDataset = async (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> => {
    const examples = await buildExamples();
    return uploadDatasetGeneric({
        datasetName: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        buildExamples: () => examples,
        ...options,
    });
};

const runExperiment = async (
    options: { readonly anthropicApiKey: string; readonly gitSha: string },
): Promise<ExperimentRunResult> => {
    const visionInvoker = buildExperimentVisionInvoker(options.anthropicApiKey);
    const entriesByCaseId = new Map<string, ManifestEntry>();
    for (const e of await loadEntries()) entriesByCaseId.set(e.id, e);

    const target = async (input: DocumentExtractionInputs): Promise<{
        readonly status: CaseRunResult['status'];
        readonly errorCode: string | null;
        readonly resultRowCount: number;
        readonly minConfidence: number;
        readonly hasCitations: boolean;
        readonly demographicsChanges: readonly string[];
    }> => {
        const entry = entriesByCaseId.get(input.caseId);
        if (entry === undefined) {
            return {
                status: 'failed',
                errorCode: 'unknown-case-id',
                resultRowCount: 0,
                minConfidence: 0,
                hasCitations: false,
                demographicsChanges: [],
            };
        }
        const verdict = await runDocumentExtractionCase(entry, { visionInvoker });
        return {
            status: verdict.status,
            errorCode: verdict.errorCode,
            resultRowCount: verdict.resultRowCount,
            minConfidence: verdict.minConfidence,
            hasCitations: verdict.hasCitations,
            demographicsChanges: verdict.demographicsChanges,
        };
    };

    const results = await evaluate(target, {
        data: DATASET_NAME,
        experimentPrefix: `document-extraction-${options.gitSha.slice(0, 7)}`,
        metadata: { git_sha: options.gitSha, suite: 'document-extraction' },
    });

    return {
        suiteName: 'document-extraction',
        datasetName: DATASET_NAME,
        experimentName: results.experimentName,
    };
};

export const documentExtractionSuite: EvalSuite = {
    name: 'document-extraction',
    datasetName: DATASET_NAME,
    uploadDataset,
    runExperiment,
};
