/**
 * PR-blocking eval gate. Wired as the GitLab `evals:gate` job per W2
 * Phase E.4. Behavior:
 *
 *   1. Estimate cost; abort if > $5/PR.
 *   2. Check vendor health; cases on degraded vendors are excluded
 *      from the regression-rate denominator (and surfaced separately).
 *   3. Run every suite's experiment in parallel against real models,
 *      tagged with `$CI_COMMIT_SHA`.
 *   4. Pull per-(case, rubric) booleans back from LangSmith via the
 *      same `Client.listRuns` + `Client.listFeedback` shape the
 *      rebaseline script uses.
 *   5. Compare against `agent/evals/baselines/eval-suite.json`.
 *   6. Compute regression rate as `flippedCells / totalScoredCells`
 *      across all four datasets. Fail when > 5%.
 *   7. Post a structured PR comment via the GitLab API summarising the
 *      result.
 *
 * Cell semantics:
 *   - "flipped" = baseline `true` AND live `false` (a regression).
 *   - A baseline `true` cell with no matching live feedback is treated
 *     as flipped — silent disappearance is a regression.
 *   - A live cell with no baseline counterpart fails the gate (drift
 *     detected; exit non-zero with an explicit error).
 *   - Vendor-outage skips remove the affected cases from BOTH numerator
 *     and denominator — they don't paper over real regressions and
 *     don't count as flips.
 *
 * The compareLive… function below is the core decision and is unit
 * tested against synthetic shapes in eval-gate.test.ts. The
 * orchestration around it (LangSmith calls, GitLab API, process.exit)
 * lives in `runGate()` and `main()`, neither of which the tests touch.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, type Feedback } from 'langsmith';

import { runExperiment } from '../evals/runners/experiment.js';
import { caseIdFromRun } from './rebaseline.js';
import { RUBRIC_KEYS, type RubricKey } from '../evals/rubrics/types.js';
import { estimateCost } from './check-cost-cap.js';
import {
    checkVendorHealth,
    SUITE_VENDOR_DEPENDENCIES,
    type Vendor,
    type VendorReport,
} from './vendor-health-check.js';

import { DATASET_NAME as BRIEFING_GRAPH_DATASET_NAME } from '../evals/runners/briefingGraphSuite.js';
import { DATASET_NAME as CONVERSATIONAL_GRAPH_DATASET_NAME } from '../evals/runners/conversationalGraphSuite.js';
import { DATASET_NAME as DOCUMENT_EXTRACTION_DATASET_NAME } from '../evals/runners/documentExtractionSuite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'evals', 'baselines', 'eval-suite.json');
/** Markdown report path. The CI job declares this file as an artifact so it survives past the job log. */
const REPORT_PATH = join(HERE, '..', 'eval-gate-report.md');

/** Tolerance: > 5% of scored cells flipped → fail the gate. */
export const REGRESSION_RATE_TOLERANCE = 0.05;

/** Map suite name → dataset name. Pinned alongside the suite imports. */
export const SUITE_TO_DATASET: Readonly<Record<string, string>> = {
    'briefing-graph': BRIEFING_GRAPH_DATASET_NAME,
    'conversational-graph': CONVERSATIONAL_GRAPH_DATASET_NAME,
    'document-extraction': DOCUMENT_EXTRACTION_DATASET_NAME,
};

interface BaselineFile {
    readonly version: number;
    readonly committedAt: string;
    readonly commitSha: string | null;
    readonly commitMessage?: string;
    readonly datasets: Record<string, { readonly cases: Record<string, Record<string, boolean>> }>;
}

/** A live (case, rubric) score pulled from a LangSmith run-feedback edge. */
export interface LiveCell {
    readonly dataset: string;
    readonly caseId: string;
    readonly rubric: RubricKey;
    readonly score: boolean;
}

/** A flipped cell, the unit of failure. */
export interface FlippedCell {
    readonly dataset: string;
    readonly caseId: string;
    readonly rubric: RubricKey;
    readonly baseline: boolean;
    readonly live: boolean | 'missing';
}

/** Skipped (case, rubric) cells excluded from numerator AND denominator. */
export interface SkippedCell {
    readonly dataset: string;
    readonly caseId: string;
    readonly reason: string;
}

/**
 * Per-(dataset, rubric) regression slice. The pooled denominator can
 * mask a single rubric collapsing on a small dataset — a slice that
 * regresses 100% on a 5-case dataset looks like 5/100 = 5% globally.
 * The brief's "no category regresses by more than 5%" reading is per
 * (dataset, rubric); both the pooled and the per-slice rule must pass.
 */
export interface RegressionSlice {
    readonly dataset: string;
    readonly rubric: RubricKey;
    readonly totalScoredCells: number;
    readonly flippedCells: number;
    readonly regressionRate: number;
    readonly underTolerance: boolean;
}

/**
 * A baselined case whose live counterpart has zero cells. A
 * fully-removed case is a structural change to the eval surface and
 * requires an explicit rebaseline step; it is not absorbed by the
 * cell-level missing-from-live treatment because the case may have had
 * baseline-`false` cells that today aren't punished for going missing.
 */
export interface RemovedBaselineCase {
    readonly dataset: string;
    readonly caseId: string;
}

export interface CompareResult {
    readonly flipped: readonly FlippedCell[];
    readonly skipped: readonly SkippedCell[];
    readonly totalScoredCells: number;
    readonly regressionRate: number;
    readonly underTolerance: boolean;
    /**
     * Drift errors: live cells whose `(dataset, caseId, rubric)` does
     * not appear in the baseline. The structural test
     * `eval-suite.test.ts` already pins `(dataset, caseId)` coverage at
     * commit time, so any drift here is a runtime divergence (e.g. a
     * stale dataset upload). We surface them so the gate fails with a
     * specific cause rather than silently ignoring rows.
     */
    readonly unknownLiveCells: readonly { dataset: string; caseId: string; rubric: RubricKey }[];
    /** Per-(dataset, rubric) slice rates. The gate fails if any slice trips. */
    readonly slices: readonly RegressionSlice[];
    /** Baselined cases with zero live cells. Forces rebaseline on case removal. */
    readonly removedBaselineCases: readonly RemovedBaselineCase[];
}

const isRubricKey = (key: string): key is RubricKey =>
    (RUBRIC_KEYS as readonly string[]).includes(key);

/**
 * Pure comparison: takes a baseline shape, a list of live cells, and
 * the set of (dataset, caseId) pairs to skip. Returns the regression
 * decision. Has no I/O — eval-gate.test.ts feeds it synthetic shapes.
 *
 * The gate enforces three rules and fails when any trips:
 *   1. Pooled regression rate ≤ tolerance.
 *   2. Per-(dataset, rubric) slice regression rate ≤ tolerance — a
 *      single rubric collapsing on a small dataset must not hide
 *      under the global denominator.
 *   3. No baselined case fully disappears from live (case removal
 *      requires an explicit rebaseline step).
 *
 * Plus the existing drift checks (unknown live cells, missing-from-live
 * for baseline-`true` cells).
 */
export const compareLiveAgainstBaseline = (
    baseline: BaselineFile,
    liveCells: readonly LiveCell[],
    skippedCases: ReadonlySet<string>,
): CompareResult => {
    // Index live cells for O(1) lookup keyed by `${dataset}::${caseId}::${rubric}`.
    const liveByKey = new Map<string, boolean>();
    // Track which (dataset, caseId) pairs have any live cells at all
    // for the M15 case-removal check.
    const liveCasePresent = new Set<string>();
    for (const c of liveCells) {
        liveByKey.set(`${c.dataset}::${c.caseId}::${c.rubric}`, c.score);
        liveCasePresent.add(`${c.dataset}::${c.caseId}`);
    }

    const flipped: FlippedCell[] = [];
    const unknownLiveCells: { dataset: string; caseId: string; rubric: RubricKey }[] = [];
    const removedBaselineCases: RemovedBaselineCase[] = [];
    // Per-slice tallies: key `${dataset}::${rubric}` → (total, flipped).
    const sliceTallies = new Map<string, { total: number; flipped: number }>();
    let totalScoredCells = 0;

    // Walk baseline. Each baselined cell that is not skipped contributes
    // to the denominator; baseline `true` AND live `false` (or missing)
    // contributes to the numerator.
    for (const [datasetName, dataset] of Object.entries(baseline.datasets)) {
        for (const [caseId, row] of Object.entries(dataset.cases)) {
            const skipKey = `${datasetName}::${caseId}`;
            if (skippedCases.has(skipKey)) continue;
            // M15: a baselined case with zero live cells (post-skip) is
            // a structural removal that must force a rebaseline. We
            // record it once per case; cell-level missing-from-live
            // logic still runs below for baseline-`true` cells that
            // would otherwise hide a regression.
            if (!liveCasePresent.has(skipKey)) {
                removedBaselineCases.push({ dataset: datasetName, caseId });
            }
            for (const [rubricStr, baselineScore] of Object.entries(row)) {
                if (!isRubricKey(rubricStr)) continue;
                const rubric: RubricKey = rubricStr;
                totalScoredCells++;
                const sliceKey = `${datasetName}::${rubric}`;
                const tally = sliceTallies.get(sliceKey) ?? { total: 0, flipped: 0 };
                tally.total++;
                const key = `${datasetName}::${caseId}::${rubric}`;
                const liveScore = liveByKey.get(key);
                if (liveScore === undefined) {
                    // Silent disappearance. A baselined cell with no
                    // live counterpart is a regression — the run
                    // either dropped the case or LangSmith dropped the
                    // feedback. Either way, treat as flipped iff the
                    // baseline was `true` (we don't punish baseline-`false`
                    // cells for going missing — the M15 case-removal
                    // check covers that gap structurally).
                    if (baselineScore === true) {
                        flipped.push({
                            dataset: datasetName,
                            caseId,
                            rubric,
                            baseline: baselineScore,
                            live: 'missing',
                        });
                        tally.flipped++;
                    }
                    sliceTallies.set(sliceKey, tally);
                    continue;
                }
                if (baselineScore === true && liveScore === false) {
                    flipped.push({
                        dataset: datasetName,
                        caseId,
                        rubric,
                        baseline: baselineScore,
                        live: liveScore,
                    });
                    tally.flipped++;
                }
                sliceTallies.set(sliceKey, tally);
            }
        }
    }

    // Walk live cells looking for ones with no baseline counterpart.
    for (const c of liveCells) {
        const skipKey = `${c.dataset}::${c.caseId}`;
        if (skippedCases.has(skipKey)) continue;
        const dataset = baseline.datasets[c.dataset];
        if (dataset === undefined) {
            unknownLiveCells.push({ dataset: c.dataset, caseId: c.caseId, rubric: c.rubric });
            continue;
        }
        const row = dataset.cases[c.caseId];
        if (row === undefined) {
            unknownLiveCells.push({ dataset: c.dataset, caseId: c.caseId, rubric: c.rubric });
            continue;
        }
        if (!(c.rubric in row)) {
            unknownLiveCells.push({ dataset: c.dataset, caseId: c.caseId, rubric: c.rubric });
        }
    }

    const skipped: SkippedCell[] = [];
    for (const skipKey of skippedCases) {
        const [dataset, caseId] = skipKey.split('::');
        if (dataset === undefined || caseId === undefined) continue;
        skipped.push({ dataset, caseId, reason: 'vendor-outage' });
    }

    // Materialize per-slice rates. Sort for stable test + report output.
    const slices: RegressionSlice[] = [];
    for (const [sliceKey, tally] of sliceTallies) {
        const [datasetName, rubricStr] = sliceKey.split('::');
        if (datasetName === undefined || rubricStr === undefined) continue;
        if (!isRubricKey(rubricStr)) continue;
        const rate = tally.total === 0 ? 0 : tally.flipped / tally.total;
        slices.push({
            dataset: datasetName,
            rubric: rubricStr,
            totalScoredCells: tally.total,
            flippedCells: tally.flipped,
            regressionRate: rate,
            underTolerance: rate <= REGRESSION_RATE_TOLERANCE,
        });
    }
    slices.sort((a, b) => {
        if (a.dataset !== b.dataset) return a.dataset.localeCompare(b.dataset);
        return a.rubric.localeCompare(b.rubric);
    });

    const regressionRate = totalScoredCells === 0 ? 0 : flipped.length / totalScoredCells;
    const allSlicesUnder = slices.every((s) => s.underTolerance);
    const underTolerance =
        regressionRate <= REGRESSION_RATE_TOLERANCE
        && allSlicesUnder
        && unknownLiveCells.length === 0
        && removedBaselineCases.length === 0;

    return {
        flipped,
        skipped,
        totalScoredCells,
        regressionRate,
        underTolerance,
        unknownLiveCells,
        slices,
        removedBaselineCases,
    };
};

/**
 * Resolve which (dataset, caseId) pairs should be skipped because a
 * vendor they depend on is degraded. Pure helper — vendor reports come
 * from `checkVendorHealth`, baseline comes from disk.
 */
export const resolveSkippedCases = (
    baseline: BaselineFile,
    vendorReports: readonly VendorReport[],
): ReadonlySet<string> => {
    const degraded = new Set<Vendor>(
        vendorReports.filter((r) => r.status === 'degraded').map((r) => r.vendor),
    );
    if (degraded.size === 0) return new Set();
    const skipped = new Set<string>();
    for (const [suite, deps] of Object.entries(SUITE_VENDOR_DEPENDENCIES)) {
        if (deps.some((d) => degraded.has(d))) {
            const datasetName = SUITE_TO_DATASET[suite];
            if (datasetName === undefined) continue;
            const dataset = baseline.datasets[datasetName];
            if (dataset === undefined) continue;
            for (const caseId of Object.keys(dataset.cases)) {
                skipped.add(`${datasetName}::${caseId}`);
            }
        }
    }
    return skipped;
};

const loadBaseline = async (path = BASELINE_PATH): Promise<BaselineFile> => {
    const buf = await readFile(path, 'utf8');
    return JSON.parse(buf) as BaselineFile;
};

const scoreToBoolean = (fb: Feedback): boolean | null => {
    if (fb.score === 1 || fb.score === true) return true;
    if (fb.score === 0 || fb.score === false) return false;
    return null;
};

/**
 * Pull every (case, rubric) live cell out of an experiment's runs.
 * Mirrors the rebaseline script's read pattern (see comment in
 * `agent/scripts/rebaseline.ts`).
 */
export const collectLiveCells = async (
    client: Client,
    datasetName: string,
    experimentName: string,
): Promise<readonly LiveCell[]> => {
    const runIdToCaseId = new Map<string, string>();
    for await (const run of client.listRuns({ projectName: experimentName, isRoot: true })) {
        const caseId = caseIdFromRun(datasetName, run);
        if (caseId === null || run.id === undefined) continue;
        runIdToCaseId.set(run.id, caseId);
    }
    const runIds = [...runIdToCaseId.keys()];
    if (runIds.length === 0) return [];
    const cells: LiveCell[] = [];
    for await (const fb of client.listFeedback({ runIds })) {
        const caseId = runIdToCaseId.get(fb.run_id);
        if (caseId === undefined) continue;
        if (!isRubricKey(fb.key)) continue;
        const score = scoreToBoolean(fb);
        if (score === null) continue;
        cells.push({ dataset: datasetName, caseId, rubric: fb.key, score });
    }
    return cells;
};

/**
 * Render a markdown summary of the gate result. The `evals:gate` job
 * posts this to the MR via the GitLab Notes API.
 */
export const renderMarkdownReport = (
    result: CompareResult,
    vendorReports: readonly VendorReport[],
    costSummary: { totalUsd: number; hardCapUsd: number },
): string => {
    const lines: string[] = [];
    const verdict = result.underTolerance ? '✅ Eval gate passed' : '❌ Eval gate failed';
    lines.push(`## ${verdict}`);
    lines.push('');
    lines.push(
        `Regression rate: **${(result.regressionRate * 100).toFixed(1)}%** (${result.flipped.length}/${result.totalScoredCells} scored cells flipped). Tolerance: ${(REGRESSION_RATE_TOLERANCE * 100).toFixed(0)}%.`,
    );
    lines.push('');
    lines.push(
        `Estimated cost: $${costSummary.totalUsd.toFixed(2)} / $${costSummary.hardCapUsd.toFixed(2)} cap.`,
    );
    const failingSlices = result.slices.filter((s) => !s.underTolerance);
    if (failingSlices.length > 0) {
        lines.push('');
        lines.push(`### Per-(dataset, rubric) slice regressions`);
        lines.push(
            'Each slice is checked against the same tolerance as the pooled rate. A small dataset where one rubric collapses can pass the pooled rule but fail here.',
        );
        for (const s of failingSlices) {
            lines.push(
                `- \`${s.dataset}::${s.rubric}\` — **${(s.regressionRate * 100).toFixed(1)}%** (${s.flippedCells}/${s.totalScoredCells})`,
            );
        }
    }
    if (result.removedBaselineCases.length > 0) {
        lines.push('');
        lines.push(`### Removed baseline cases`);
        lines.push(
            'Cases present in the baseline produced zero live cells. Case removal is a structural change to the eval surface — rebaseline (deliberate) or restore the missing case.',
        );
        for (const c of result.removedBaselineCases) {
            lines.push(`- \`${c.dataset}::${c.caseId}\``);
        }
    }
    if (result.unknownLiveCells.length > 0) {
        lines.push('');
        lines.push(`### Drift detected (live cells with no baseline counterpart)`);
        for (const c of result.unknownLiveCells) {
            lines.push(`- \`${c.dataset}::${c.caseId}::${c.rubric}\``);
        }
        lines.push('');
        lines.push(
            'Drift means the live experiment has rows the baseline does not pin. Either rebaseline (deliberate) or fix the divergence.',
        );
    }
    if (result.flipped.length > 0) {
        lines.push('');
        lines.push(`### Flipped cells`);
        for (const c of result.flipped) {
            lines.push(`- \`${c.dataset}::${c.caseId}::${c.rubric}\` — baseline ${c.baseline}, live ${String(c.live)}`);
        }
    }
    const degraded = vendorReports.filter((r) => r.status === 'degraded');
    if (degraded.length > 0) {
        lines.push('');
        lines.push(`### Vendor-outage skips`);
        for (const r of degraded) {
            lines.push(`- \`${r.vendor}\` — ${r.reason ?? 'unknown reason'}`);
        }
        if (result.skipped.length > 0) {
            lines.push('');
            lines.push(
                `${result.skipped.length} (dataset, case) pair${result.skipped.length === 1 ? '' : 's'} excluded from numerator and denominator due to the outages above.`,
            );
        }
    }
    return lines.join('\n');
};

/**
 * Post the markdown summary to the MR. No-op when not in a merge_request
 * pipeline or when no API token is available.
 *
 * Auth precedence: `GITLAB_API_TOKEN` (PAT or project access token with
 * `api` scope) is preferred when set — it works against any self-hosted
 * GitLab. `CI_JOB_TOKEN` is the fallback; many self-hosted GitLab
 * instances reject job-token writes to the Notes API with 401, so the
 * fallback is best-effort. The job log already contains the rendered
 * markdown verbatim either way, so a missing comment is cosmetic, not
 * a failure mode.
 */
const postGitlabComment = async (markdown: string, fetchImpl: typeof fetch = fetch): Promise<void> => {
    const projectId = process.env['CI_PROJECT_ID'];
    const mrIid = process.env['CI_MERGE_REQUEST_IID'];
    const apiUrl = process.env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';
    const apiToken = process.env['GITLAB_API_TOKEN'];
    const jobToken = process.env['CI_JOB_TOKEN'];
    if (
        projectId === undefined ||
        mrIid === undefined ||
        projectId.length === 0 ||
        mrIid.length === 0
    ) {
        process.stdout.write('eval-gate: not in an MR pipeline; skipping GitLab comment\n');
        return;
    }
    let headers: Record<string, string>;
    if (apiToken !== undefined && apiToken.length > 0) {
        headers = { 'PRIVATE-TOKEN': apiToken, 'content-type': 'application/json' };
    } else if (jobToken !== undefined && jobToken.length > 0) {
        headers = { 'JOB-TOKEN': jobToken, 'content-type': 'application/json' };
    } else {
        process.stdout.write('eval-gate: no GitLab token available; skipping GitLab comment\n');
        return;
    }
    const url = `${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes`;
    const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: markdown }),
    });
    if (!res.ok) {
        process.stderr.write(
            `eval-gate: GitLab Notes API returned ${res.status} when posting MR comment (gate result is in the job log above)\n`,
        );
    }
};

interface RunGateResult {
    readonly compare: CompareResult;
    readonly markdown: string;
    readonly costUsd: number;
}

/**
 * Top-level gate orchestration. Returns the comparison result + a
 * pre-rendered markdown summary; the caller (main) handles
 * `process.exit` and PR-comment posting. Tests stub `runExperiment`,
 * `cellCollector`, and `clientFactory` to drive the full path without
 * vendor calls.
 */
export const runGate = async (
    options: {
        readonly runExperimentImpl?: typeof runExperiment;
        readonly cellCollector?: (
            client: Client,
            datasetName: string,
            experimentName: string,
        ) => Promise<readonly LiveCell[]>;
        readonly clientFactory?: (apiKey: string) => Client;
        readonly baselinePath?: string;
        readonly vendorReports?: readonly VendorReport[];
        /** Test seam: override the cost estimator so the runGate path stays hermetic. */
        readonly estimateCostImpl?: typeof estimateCost;
        /**
         * Path to write the rendered markdown report to. Defaults to
         * `agent/eval-gate-report.md`; the CI job declares this file as
         * an `artifacts.paths` entry so it survives past the job log.
         * Tests pass a tmp path to assert the file is written.
         */
        readonly reportPath?: string;
    } = {},
): Promise<RunGateResult> => {
    const baseline = await loadBaseline(options.baselinePath);

    const costEstimator = options.estimateCostImpl ?? estimateCost;
    const cost = await costEstimator();
    if (!cost.underCap) {
        throw new Error(
            `eval-gate: cost estimate $${cost.totalUsd.toFixed(2)} exceeds hard cap $${cost.hardCapUsd.toFixed(2)}`,
        );
    }

    const vendor =
        options.vendorReports !== undefined
            ? { reports: options.vendorReports, degradedVendors: [] }
            : await checkVendorHealth();
    const skippedCases = resolveSkippedCases(baseline, vendor.reports);

    const runner = options.runExperimentImpl ?? runExperiment;
    const experimentResult = await runner();
    if (!experimentResult.ranExperiment) {
        throw new Error(
            `eval-gate: experiment did not run — ${experimentResult.skippedReason ?? 'unknown reason'}`,
        );
    }

    const apiKey = process.env['LANGSMITH_API_KEY'] ?? '';
    if (apiKey.length === 0) {
        throw new Error('eval-gate: LANGSMITH_API_KEY not set');
    }
    const clientFactory = options.clientFactory ?? ((key: string) => new Client({ apiKey: key }));
    const client = clientFactory(apiKey);
    const collector = options.cellCollector ?? collectLiveCells;

    const liveCells: LiveCell[] = [];
    for (const result of experimentResult.results) {
        if (result.experimentName === undefined) continue;
        const cells = await collector(client, result.datasetName, result.experimentName);
        for (const c of cells) liveCells.push(c);
    }

    const compare = compareLiveAgainstBaseline(baseline, liveCells, skippedCases);
    const markdown = renderMarkdownReport(compare, vendor.reports, {
        totalUsd: cost.totalUsd,
        hardCapUsd: cost.hardCapUsd,
    });
    // Persist the rendered report so the CI job can declare it as an
    // artifact. Failure to write is non-fatal — the markdown is still
    // returned to the caller and printed to stdout in `main`. Tests
    // pass `reportPath` explicitly to assert the file lands.
    const reportPath = options.reportPath ?? REPORT_PATH;
    try {
        await writeFile(reportPath, `${markdown}\n`, 'utf8');
    } catch (err) {
        process.stderr.write(
            `eval-gate: failed to persist markdown report to ${reportPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
    }
    return { compare, markdown, costUsd: cost.totalUsd };
};

const main = async (): Promise<void> => {
    const result = await runGate();
    process.stdout.write(`${result.markdown}\n`);
    await postGitlabComment(result.markdown);
    if (!result.compare.underTolerance) {
        const reasons: string[] = [];
        if (result.compare.regressionRate > REGRESSION_RATE_TOLERANCE) {
            reasons.push(
                `pooled regression rate ${(result.compare.regressionRate * 100).toFixed(1)}% > ${(REGRESSION_RATE_TOLERANCE * 100).toFixed(0)}%`,
            );
        }
        const failingSlices = result.compare.slices.filter((s) => !s.underTolerance);
        if (failingSlices.length > 0) {
            reasons.push(
                `${failingSlices.length} (dataset, rubric) slice${failingSlices.length === 1 ? '' : 's'} over tolerance`,
            );
        }
        if (result.compare.removedBaselineCases.length > 0) {
            reasons.push(
                `${result.compare.removedBaselineCases.length} baseline case${result.compare.removedBaselineCases.length === 1 ? '' : 's'} removed from live`,
            );
        }
        if (result.compare.unknownLiveCells.length > 0) {
            reasons.push(`${result.compare.unknownLiveCells.length} drift cell${result.compare.unknownLiveCells.length === 1 ? '' : 's'}`);
        }
        process.stderr.write(`eval-gate: ${reasons.join('; ')}\n`);
        process.exit(1);
    }
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    void main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`eval-gate: ${message}\n`);
        process.exit(1);
    });
}
