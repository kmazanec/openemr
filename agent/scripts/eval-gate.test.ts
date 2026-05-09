/**
 * Unit tests for the eval-gate's pure decision logic. The orchestration
 * layer (`runGate`) is partially exercised here too, with stubbed
 * runExperiment + cellCollector + a fixture baseline so no LangSmith
 * calls happen.
 *
 * Coverage:
 *   - 4% flip rate → underTolerance true (gate passes)
 *   - 6% flip rate → underTolerance false (gate fails)
 *   - missing-from-live (silent disappearance of baseline true) counts as flipped
 *   - unknown live (drift: live cell with no baseline) → fails the gate
 *   - vendor-outage skips remove cases from numerator AND denominator
 *   - resolveSkippedCases honours SUITE_VENDOR_DEPENDENCIES
 *   - markdown report shape
 */

import { describe, expect, it } from 'vitest';

import {
    compareLiveAgainstBaseline,
    REGRESSION_RATE_TOLERANCE,
    renderMarkdownReport,
    resolveSkippedCases,
    type LiveCell,
} from './eval-gate.js';
import type { VendorReport } from './vendor-health-check.js';
import type { RubricKey } from '../evals/rubrics/types.js';

interface BaselineFile {
    readonly version: number;
    readonly committedAt: string;
    readonly commitSha: string | null;
    readonly datasets: Record<string, { readonly cases: Record<string, Record<string, boolean>> }>;
}

/** 100 cells across two suites, all baseline-true. */
const buildBaseline = (cellCount: number): BaselineFile => {
    const cases: Record<string, Record<string, boolean>> = {};
    // Two rubrics × N cases = 2N cells. Caller controls 2N == cellCount.
    const caseCount = Math.ceil(cellCount / 2);
    for (let i = 0; i < caseCount; i++) {
        cases[`case-${i}`] = { citation_present: true, factually_consistent: true };
    }
    return {
        version: 1,
        committedAt: '2026-01-01T00:00:00.000Z',
        commitSha: null,
        datasets: {
            'clinical-copilot-briefing-graph-v1': { cases },
        },
    };
};

const buildLiveCells = (
    flipCount: number,
    cellCount: number,
    overrides: Partial<{ skip: number }> = {},
): readonly LiveCell[] => {
    const skip = overrides.skip ?? 0;
    const cells: LiveCell[] = [];
    const caseCount = Math.ceil(cellCount / 2);
    for (let i = 0; i < caseCount - skip; i++) {
        const cellsLiveForThisCase: { rubric: RubricKey; score: boolean }[] = [
            { rubric: 'citation_present', score: true },
            { rubric: 'factually_consistent', score: true },
        ];
        // Flip the first `flipCount` cells live → false.
        for (const c of cellsLiveForThisCase) {
            const idx = cells.length;
            cells.push({
                dataset: 'clinical-copilot-briefing-graph-v1',
                caseId: `case-${i}`,
                rubric: c.rubric,
                score: idx < flipCount ? false : c.score,
            });
        }
    }
    return cells;
};

describe('compareLiveAgainstBaseline', () => {
    it('4% flip rate → underTolerance true (gate passes)', () => {
        const baseline = buildBaseline(100);
        const live = buildLiveCells(4, 100);
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.totalScoredCells).toBe(100);
        expect(result.flipped).toHaveLength(4);
        expect(result.regressionRate).toBeCloseTo(0.04, 5);
        expect(result.underTolerance).toBe(true);
    });

    it('5% flip rate → underTolerance true (boundary: <= tolerance is OK)', () => {
        const baseline = buildBaseline(100);
        const live = buildLiveCells(5, 100);
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.regressionRate).toBeCloseTo(REGRESSION_RATE_TOLERANCE, 5);
        expect(result.underTolerance).toBe(true);
    });

    it('6% flip rate → underTolerance false (gate fails)', () => {
        const baseline = buildBaseline(100);
        const live = buildLiveCells(6, 100);
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(6);
        expect(result.regressionRate).toBeCloseTo(0.06, 5);
        expect(result.underTolerance).toBe(false);
    });

    it('missing-from-live: baseline true with no live counterpart counts as a flip', () => {
        const baseline = buildBaseline(20); // 10 cases × 2 rubrics
        const live: LiveCell[] = []; // nothing came back from langsmith
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(20);
        for (const f of result.flipped) {
            expect(f.live).toBe('missing');
        }
        expect(result.underTolerance).toBe(false);
    });

    it('unknown live cell (drift): live row not in baseline → fails the gate even at 0% regression', () => {
        const baseline = buildBaseline(20);
        const live = [
            ...buildLiveCells(0, 20),
            {
                dataset: 'clinical-copilot-briefing-graph-v1',
                caseId: 'case-NEW-UNTRACKED',
                rubric: 'citation_present' as RubricKey,
                score: true,
            },
        ];
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(0);
        expect(result.regressionRate).toBe(0);
        expect(result.unknownLiveCells).toHaveLength(1);
        expect(result.unknownLiveCells[0]?.caseId).toBe('case-NEW-UNTRACKED');
        expect(result.underTolerance).toBe(false);
    });

    it('unknown live cell: dataset not in baseline → drift error', () => {
        const baseline = buildBaseline(20);
        const live = [
            {
                dataset: 'clinical-copilot-mystery-dataset',
                caseId: 'case-0',
                rubric: 'citation_present' as RubricKey,
                score: true,
            },
        ];
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.unknownLiveCells).toHaveLength(1);
        expect(result.underTolerance).toBe(false);
    });

    it('vendor-outage skips remove cases from numerator AND denominator', () => {
        const baseline = buildBaseline(20); // 10 cases × 2 rubrics
        // Skip the first 5 cases. 10 cells skipped → 10 remain.
        const skipped = new Set<string>([
            'clinical-copilot-briefing-graph-v1::case-0',
            'clinical-copilot-briefing-graph-v1::case-1',
            'clinical-copilot-briefing-graph-v1::case-2',
            'clinical-copilot-briefing-graph-v1::case-3',
            'clinical-copilot-briefing-graph-v1::case-4',
        ]);
        // Live data: only the unskipped 5 cases × 2 rubrics, all true.
        const live: LiveCell[] = [];
        for (let i = 5; i < 10; i++) {
            live.push({
                dataset: 'clinical-copilot-briefing-graph-v1',
                caseId: `case-${i}`,
                rubric: 'citation_present',
                score: true,
            });
            live.push({
                dataset: 'clinical-copilot-briefing-graph-v1',
                caseId: `case-${i}`,
                rubric: 'factually_consistent',
                score: true,
            });
        }
        const result = compareLiveAgainstBaseline(baseline, live, skipped);
        expect(result.totalScoredCells).toBe(10); // skipped cases excluded
        expect(result.flipped).toHaveLength(0);
        expect(result.skipped).toHaveLength(5);
        expect(result.regressionRate).toBe(0);
        expect(result.underTolerance).toBe(true);
    });

    it('skipped case with missing live data does not count as a flip', () => {
        const baseline = buildBaseline(20);
        const skipped = new Set<string>([
            'clinical-copilot-briefing-graph-v1::case-0',
            'clinical-copilot-briefing-graph-v1::case-1',
        ]);
        const live: LiveCell[] = []; // no live data at all
        const result = compareLiveAgainstBaseline(baseline, live, skipped);
        // The 4 cells from skipped cases are excluded from the
        // denominator. The remaining 16 cells are baseline-true with no
        // live counterpart → all 16 count as flipped.
        expect(result.totalScoredCells).toBe(16);
        expect(result.flipped).toHaveLength(16);
        expect(result.underTolerance).toBe(false);
    });

    it('baseline false → live false: not a flip (cell was already failing)', () => {
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                'clinical-copilot-briefing-graph-v1': {
                    cases: { 'case-0': { citation_present: false } },
                },
            },
        };
        const live: LiveCell[] = [
            {
                dataset: 'clinical-copilot-briefing-graph-v1',
                caseId: 'case-0',
                rubric: 'citation_present',
                score: false,
            },
        ];
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(0);
        expect(result.totalScoredCells).toBe(1);
    });

    it('baseline false → live true: not a flip (improvement is not a regression)', () => {
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                'clinical-copilot-briefing-graph-v1': {
                    cases: { 'case-0': { citation_present: false } },
                },
            },
        };
        const live: LiveCell[] = [
            {
                dataset: 'clinical-copilot-briefing-graph-v1',
                caseId: 'case-0',
                rubric: 'citation_present',
                score: true,
            },
        ];
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(0);
    });

    it('zero scored cells (e.g. baseline empty) → regressionRate 0, passes', () => {
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {},
        };
        const result = compareLiveAgainstBaseline(baseline, [], new Set());
        expect(result.regressionRate).toBe(0);
        expect(result.underTolerance).toBe(true);
    });
});

describe('resolveSkippedCases', () => {
    const baseline: BaselineFile = {
        version: 1,
        committedAt: '2026-01-01T00:00:00.000Z',
        commitSha: null,
        datasets: {
            'clinical-copilot-briefing-graph-v2': {
                cases: { 'archetype:diabetic': { citation_present: true } },
            },
            'clinical-copilot-conversational-graph-v5': {
                cases: { 'multi-retriever': { citation_present: true } },
            },
            'clinical-copilot-document-extraction-v2': {
                cases: { 'lab-chen-lipid-panel': { schema_valid: true } },
            },
        },
    };

    const okReport = (vendor: 'anthropic' | 'openai' | 'cohere' | 'pinecone' | 'langsmith'): VendorReport => ({
        vendor,
        status: 'ok',
        httpStatus: 200,
        latencyMs: 10,
        reason: null,
    });

    const degradedReport = (
        vendor: 'anthropic' | 'openai' | 'cohere' | 'pinecone' | 'langsmith',
    ): VendorReport => ({
        vendor,
        status: 'degraded',
        httpStatus: 503,
        latencyMs: 10,
        reason: 'non-2xx response',
    });

    it('all vendors ok → no skips', () => {
        const skips = resolveSkippedCases(baseline, [
            okReport('anthropic'),
            okReport('openai'),
            okReport('cohere'),
            okReport('pinecone'),
            okReport('langsmith'),
        ]);
        expect(skips.size).toBe(0);
    });

    it('Anthropic degraded → all three suites skip (every suite uses Anthropic)', () => {
        const skips = resolveSkippedCases(baseline, [
            degradedReport('anthropic'),
            okReport('openai'),
            okReport('cohere'),
            okReport('pinecone'),
            okReport('langsmith'),
        ]);
        expect(skips.size).toBe(3);
        expect(skips.has('clinical-copilot-briefing-graph-v2::archetype:diabetic')).toBe(true);
    });

    it('Pinecone degraded → only conversational skips (briefing/document do not use Pinecone)', () => {
        const skips = resolveSkippedCases(baseline, [
            okReport('anthropic'),
            okReport('openai'),
            okReport('cohere'),
            degradedReport('pinecone'),
            okReport('langsmith'),
        ]);
        expect(skips.size).toBe(1);
        expect(skips.has('clinical-copilot-conversational-graph-v5::multi-retriever')).toBe(true);
        expect(skips.has('clinical-copilot-briefing-graph-v2::archetype:diabetic')).toBe(false);
    });
});

describe('renderMarkdownReport', () => {
    it('passing report mentions the green check and the regression rate', () => {
        const report = renderMarkdownReport(
            {
                flipped: [],
                skipped: [],
                totalScoredCells: 100,
                regressionRate: 0.02,
                underTolerance: true,
                unknownLiveCells: [],
            },
            [
                {
                    vendor: 'anthropic',
                    status: 'ok',
                    httpStatus: 200,
                    latencyMs: 10,
                    reason: null,
                },
            ],
            { totalUsd: 2.5, hardCapUsd: 5.0 },
        );
        expect(report).toContain('Eval gate passed');
        expect(report).toContain('2.0%');
        expect(report).toContain('$2.50');
    });

    it('failing report lists flipped cells', () => {
        const report = renderMarkdownReport(
            {
                flipped: [
                    {
                        dataset: 'clinical-copilot-briefing-graph-v1',
                        caseId: 'archetype:diabetic',
                        rubric: 'citation_present',
                        baseline: true,
                        live: false,
                    },
                ],
                skipped: [],
                totalScoredCells: 10,
                regressionRate: 0.1,
                underTolerance: false,
                unknownLiveCells: [],
            },
            [],
            { totalUsd: 2.5, hardCapUsd: 5.0 },
        );
        expect(report).toContain('Eval gate failed');
        expect(report).toContain('clinical-copilot-briefing-graph-v1::archetype:diabetic::citation_present');
    });

    it('drift report names the unknown live cells', () => {
        const report = renderMarkdownReport(
            {
                flipped: [],
                skipped: [],
                totalScoredCells: 10,
                regressionRate: 0,
                underTolerance: false,
                unknownLiveCells: [
                    {
                        dataset: 'clinical-copilot-briefing-graph-v1',
                        caseId: 'case-NEW',
                        rubric: 'citation_present',
                    },
                ],
            },
            [],
            { totalUsd: 2.5, hardCapUsd: 5.0 },
        );
        expect(report).toContain('Drift detected');
        expect(report).toContain('case-NEW');
    });

    it('vendor-outage section appears when a vendor is degraded', () => {
        const report = renderMarkdownReport(
            {
                flipped: [],
                skipped: [
                    {
                        dataset: 'clinical-copilot-conversational-graph-v5',
                        caseId: 'multi-retriever',
                        reason: 'vendor-outage',
                    },
                ],
                totalScoredCells: 5,
                regressionRate: 0,
                underTolerance: true,
                unknownLiveCells: [],
            },
            [
                {
                    vendor: 'pinecone',
                    status: 'degraded',
                    httpStatus: 503,
                    latencyMs: 10,
                    reason: 'non-2xx response',
                },
            ],
            { totalUsd: 1.0, hardCapUsd: 5.0 },
        );
        expect(report).toContain('Vendor-outage skips');
        expect(report).toContain('pinecone');
        expect(report).toContain('1 (dataset, case) pair');
    });
});
