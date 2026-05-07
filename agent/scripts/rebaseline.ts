/**
 * Rebaseline script for `agent/evals/baselines/eval-suite.json`.
 *
 * Walks every dataset in the suite registry, finds the most recent
 * LangSmith experiment for that dataset, pulls every run's per-rubric
 * feedback, and writes the unified baseline file. The Phase E.4 CI
 * gate compares live experiment runs against this file; rebaselining
 * is the deliberate, documented step that updates expectations after
 * an intentional rubric tightening, model upgrade, or suite expansion.
 *
 * Per `docs/RUNBOOK.md` §"Rebaselining the eval suite", the script
 * refuses to write unless invoked with both `--confirm` and a
 * `--commit-message <text>` argument. The commit message is recorded
 * in the baseline file's `committedAt`/`commitSha` audit fields and
 * is intended to land in the rebaseline PR's commit body.
 *
 * Implementation notes:
 *   - Uses `Client.listRuns({ projectName })` (the LangSmith project
 *     for an experiment is keyed by experiment name, see
 *     https://docs.smith.langchain.com/observability/concepts) to
 *     stream every run from the experiment, then `client.listFeedback`
 *     to read the per-rubric scores attached to each run.
 *   - Refuses to run when LANGSMITH_API_KEY is missing (exit code 2)
 *     — the script is a deliberate operation, not a CI step.
 *   - Maps each run back to its case id via `run.inputs`. The four
 *     suites encode case ids slightly differently; the case-id
 *     reducer here mirrors how each suite's example uploader builds
 *     its `metadata.caseId` (or equivalent).
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client, type Feedback, type Run } from 'langsmith';

import { DATASET_NAME as BRIEFING_GRAPH_DATASET_NAME } from '../evals/runners/briefingGraphSuite.js';
import { DATASET_NAME as CONVERSATIONAL_GRAPH_DATASET_NAME } from '../evals/runners/conversationalGraphSuite.js';
import { DATASET_NAME as DOCUMENT_EXTRACTION_DATASET_NAME } from '../evals/runners/documentExtractionSuite.js';
import { DATASET_NAME as END_TO_END_DATASET_NAME } from '../evals/runners/endToEndSuite.js';
import { RUBRIC_KEYS, type RubricKey } from '../evals/rubrics/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'evals', 'baselines', 'eval-suite.json');

export interface ParsedArgs {
    readonly confirm: boolean;
    readonly commitMessage: string | null;
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
    let confirm = false;
    let commitMessage: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--confirm') {
            confirm = true;
            continue;
        }
        if (arg === '--commit-message') {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new Error('--commit-message requires a non-empty argument');
            }
            commitMessage = next;
            i++;
            continue;
        }
        if (arg?.startsWith('--commit-message=')) {
            commitMessage = arg.slice('--commit-message='.length);
            continue;
        }
    }
    return { confirm, commitMessage };
};

interface BaselineFile {
    readonly version: number;
    readonly committedAt: string;
    readonly commitSha: string | null;
    readonly commitMessage: string;
    readonly datasets: Record<string, { readonly cases: Record<string, Record<RubricKey, boolean>> }>;
}

const DATASETS = [
    BRIEFING_GRAPH_DATASET_NAME,
    CONVERSATIONAL_GRAPH_DATASET_NAME,
    END_TO_END_DATASET_NAME,
    DOCUMENT_EXTRACTION_DATASET_NAME,
] as const;

/**
 * Reduce a run's `inputs` object back to the case id used in the
 * baseline file. Each suite's example uploader builds `metadata.caseId`
 * (briefing) or stores the case id directly under `inputs.group`
 * (conversational), `inputs.scenario` (end-to-end), or `inputs.caseId`
 * (document-extraction). The reducer mirrors those uploaders so a
 * run-feedback row maps unambiguously to one baseline row.
 */
export const caseIdFromRun = (datasetName: string, run: Run): string | null => {
    const inputs = (run.inputs ?? {}) as Record<string, unknown>;
    if (datasetName === DOCUMENT_EXTRACTION_DATASET_NAME) {
        const id = inputs['caseId'];
        return typeof id === 'string' ? id : null;
    }
    if (datasetName === CONVERSATIONAL_GRAPH_DATASET_NAME) {
        const group = inputs['group'];
        return typeof group === 'string' ? group : null;
    }
    if (datasetName === END_TO_END_DATASET_NAME) {
        const scenario = inputs['scenario'];
        return typeof scenario === 'string' ? scenario : null;
    }
    if (datasetName === BRIEFING_GRAPH_DATASET_NAME) {
        const kind = inputs['caseKind'];
        if (kind === 'archetype' && typeof inputs['archetype'] === 'string') {
            return `archetype:${inputs['archetype']}`;
        }
        if (kind === 'lab-trend' && typeof inputs['scenario'] === 'string') {
            return `lab-trend:${inputs['scenario']}`;
        }
        if (kind === 'morning-prep' && typeof inputs['appointmentId'] === 'string') {
            return `morning-prep:${inputs['appointmentId']}`;
        }
        return null;
    }
    return null;
};

const isRubricKey = (key: string): key is RubricKey =>
    (RUBRIC_KEYS as readonly string[]).includes(key);

/**
 * Look up the latest experiment session for a dataset by listing
 * tracing projects whose `reference_dataset_id` matches the dataset
 * and picking the one with the most recent `start_time`. Callers that
 * need to pin a non-latest experiment pass `experimentNameByDataset`
 * to the exported `rebaseline()` function instead.
 */
const resolveLatestExperimentName = async (
    client: Client,
    datasetName: string,
): Promise<string | null> => {
    const dataset = await client.readDataset({ datasetName });
    let latestName: string | null = null;
    let latestStart: string | null = null;
    // `listProjects` is the public surface; experiments are stored as
    // tracing projects keyed by reference_dataset_id.
    for await (const session of client.listProjects({ referenceDatasetId: dataset.id })) {
        const startTime: unknown = (session as unknown as { start_time?: string }).start_time;
        const name = (session as unknown as { name?: string }).name;
        if (typeof name !== 'string') continue;
        if (typeof startTime === 'string') {
            if (latestStart === null || startTime > latestStart) {
                latestStart = startTime;
                latestName = name;
            }
        } else {
            latestName ??= name;
        }
    }
    return latestName;
};

interface RebaselineOptions {
    readonly client: Client;
    readonly experimentNameByDataset?: Readonly<Partial<Record<string, string>>>;
}

export const rebaseline = async (options: RebaselineOptions): Promise<BaselineFile['datasets']> => {
    const datasets: BaselineFile['datasets'] = {};
    for (const datasetName of DATASETS) {
        const override = options.experimentNameByDataset?.[datasetName];
        const experimentName =
            override ?? (await resolveLatestExperimentName(options.client, datasetName));
        if (experimentName === null) {
            throw new Error(
                `no experiment found for dataset ${datasetName}; run npm run evals:experiment first or call rebaseline() with experimentNameByDataset override`,
            );
        }
        const cases: Record<string, Record<RubricKey, boolean>> = {};
        const runIdToCaseId = new Map<string, string>();
        for await (const run of options.client.listRuns({
            projectName: experimentName,
            isRoot: true,
        })) {
            const caseId = caseIdFromRun(datasetName, run);
            if (caseId === null || run.id === undefined) continue;
            runIdToCaseId.set(run.id, caseId);
            cases[caseId] ??= {} as Record<RubricKey, boolean>;
        }
        const runIds = [...runIdToCaseId.keys()];
        if (runIds.length === 0) continue;
        for await (const fb of options.client.listFeedback({ runIds })) {
            const caseId = runIdToCaseId.get(fb.run_id);
            if (caseId === undefined) continue;
            if (!isRubricKey(fb.key)) continue;
            const score = scoreToBoolean(fb);
            if (score === null) continue;
            cases[caseId]![fb.key] = score;
        }
        datasets[datasetName] = { cases: sortCases(cases) };
    }
    return datasets;
};

/**
 * Sort case-id keys alphabetically and, within each row, sort the
 * rubric keys alphabetically too. LangSmith's `listRuns` returns runs
 * in temporal order, so without this every rebaseline shuffles the
 * file and produces unreviewable diffs.
 */
export const sortCases = (
    cases: Record<string, Record<RubricKey, boolean>>,
): Record<string, Record<RubricKey, boolean>> =>
    Object.fromEntries(
        Object.entries(cases)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([caseId, row]) => [
                caseId,
                Object.fromEntries(
                    Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
                ) as Record<RubricKey, boolean>,
            ]),
    );

/**
 * Sort dataset-name keys alphabetically. `DATASETS` already iterates
 * in a fixed order, but sorting here makes the output deterministic
 * regardless of source iteration order.
 */
export const sortDatasets = (
    datasets: BaselineFile['datasets'],
): BaselineFile['datasets'] =>
    Object.fromEntries(Object.entries(datasets).sort(([a], [b]) => a.localeCompare(b)));

/**
 * The boolean rubrics emit `score: 0 | 1`. A skip emits no score
 * (the `RubricResult` shape omits the field). LangSmith stores
 * skipped feedbacks with `score: null`, which we drop — N/A rubrics
 * are not pinned in the baseline.
 */
const scoreToBoolean = (fb: Feedback): boolean | null => {
    if (fb.score === 1 || fb.score === true) return true;
    if (fb.score === 0 || fb.score === false) return false;
    return null;
};

const writeBaseline = async (
    datasets: BaselineFile['datasets'],
    commitMessage: string,
): Promise<void> => {
    const file: BaselineFile = {
        version: 1,
        committedAt: new Date().toISOString(),
        commitSha: process.env['CI_COMMIT_SHA'] ?? null,
        commitMessage,
        datasets: sortDatasets(datasets),
    };
    const body = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(BASELINE_PATH, body, { encoding: 'utf8' });
};

const main = async (): Promise<void> => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.confirm) {
        process.stderr.write(
            'rebaseline.ts: refusing to write — pass --confirm to proceed.\n' +
                'Usage: tsx scripts/rebaseline.ts --confirm --commit-message "<text>"\n',
        );
        process.exit(2);
    }
    if (args.commitMessage === null || args.commitMessage.length === 0) {
        process.stderr.write(
            'rebaseline.ts: refusing to write — pass --commit-message "<text>" describing the rebaseline reason.\n',
        );
        process.exit(2);
    }
    const apiKey = process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        process.stderr.write('rebaseline.ts: LANGSMITH_API_KEY not set.\n');
        process.exit(2);
    }
    const client = new Client({ apiKey });
    const datasets = await rebaseline({ client });
    await writeBaseline(datasets, args.commitMessage);
    process.stdout.write(
        `rebaseline.ts: wrote ${BASELINE_PATH}\n  message: ${args.commitMessage}\n`,
    );
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    void main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`rebaseline.ts: ${message}\n`);
        process.exit(1);
    });
}
