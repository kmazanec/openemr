/**
 * Unit tests for the eval-gate's pure decision logic plus the
 * orchestration layer (`runGate`), with stubbed runExperiment +
 * cellCollector + estimateCost + a fixture baseline so no LangSmith
 * calls happen.
 *
 * Coverage:
 *   - 4% flip rate → underTolerance true (gate passes)
 *   - boundary: every slice exactly at tolerance → passes
 *   - 6% flip rate → underTolerance false (gate fails)
 *   - missing-from-live (silent disappearance of baseline true) counts as flipped
 *   - unknown live (drift: live cell with no baseline) → fails the gate
 *   - vendor-outage skips remove cases from numerator AND denominator
 *   - resolveSkippedCases honours SUITE_VENDOR_DEPENDENCIES
 *   - per-(dataset, rubric) slice trips the gate even when pooled rate passes
 *   - per-slice rates are computed for every baselined (dataset, rubric) pair
 *   - case removal: a baselined case with zero live cells fails the gate
 *   - vendor-skipped case is NOT counted as removed
 *   - case removal flags a baseline-false case (cell-level missing-from-live wouldn't catch)
 *   - markdown report shape: passing, failing, drift, vendor outage, slice failures, removed cases
 *   - runGate persists the rendered report to disk on both pass and fail
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    compareLiveAgainstBaseline,
    REGRESSION_RATE_TOLERANCE,
    renderMarkdownReport,
    resolveSkippedCases,
    runGate,
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
        expect(result.removedBaselineCases).toHaveLength(0);
        // Per-(dataset, rubric) slices: 50 cells per rubric, the 4
        // flips spread evenly (case-0 + case-1, both rubrics) → 4%
        // each, both under tolerance.
        expect(result.slices).toHaveLength(2);
        for (const s of result.slices) {
            expect(s.totalScoredCells).toBe(50);
            expect(s.flippedCells).toBe(2);
            expect(s.regressionRate).toBeCloseTo(0.04, 5);
            expect(s.underTolerance).toBe(true);
        }
    });

    it('boundary: every slice exactly at tolerance → passes', () => {
        // 200 cells across 2 rubrics × 100 cases. Flip cases 0..4 on
        // both rubrics → 5 flips per rubric / 100 cells per slice = 5%
        // each, exactly at tolerance. Pooled rate is also exactly 5%.
        const baseline = buildBaseline(200);
        const live: LiveCell[] = [];
        const dataset = 'clinical-copilot-briefing-graph-v1';
        for (let i = 0; i < 100; i++) {
            for (const rubric of ['citation_present', 'factually_consistent'] as const) {
                live.push({
                    dataset,
                    caseId: `case-${i}`,
                    rubric,
                    score: i < 5 ? false : true,
                });
            }
        }
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.regressionRate).toBeCloseTo(REGRESSION_RATE_TOLERANCE, 5);
        for (const s of result.slices) {
            expect(s.regressionRate).toBeCloseTo(REGRESSION_RATE_TOLERANCE, 5);
            expect(s.underTolerance).toBe(true);
        }
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

    it('H7: pooled rate under tolerance but a single (dataset, rubric) slice over → fails', () => {
        // Two datasets to give the pooled denominator room to hide a
        // small-dataset slice. 100 cells in big dataset (all clean),
        // 10 cells in small dataset where citation_present collapses
        // 100% (5/5) and factually_consistent passes (0/5).
        // Pooled flips = 5 / (100 + 10) = 4.5% < 5%. Slice
        // `small::citation_present` = 100% → must fail the gate.
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                big: {
                    cases: Object.fromEntries(
                        Array.from({ length: 50 }, (_, i) => [
                            `case-${i}`,
                            { citation_present: true, factually_consistent: true },
                        ]),
                    ),
                },
                small: {
                    cases: Object.fromEntries(
                        Array.from({ length: 5 }, (_, i) => [
                            `case-${i}`,
                            { citation_present: true, factually_consistent: true },
                        ]),
                    ),
                },
            },
        };
        const live: LiveCell[] = [];
        for (let i = 0; i < 50; i++) {
            live.push({ dataset: 'big', caseId: `case-${i}`, rubric: 'citation_present', score: true });
            live.push({ dataset: 'big', caseId: `case-${i}`, rubric: 'factually_consistent', score: true });
        }
        for (let i = 0; i < 5; i++) {
            live.push({ dataset: 'small', caseId: `case-${i}`, rubric: 'citation_present', score: false });
            live.push({ dataset: 'small', caseId: `case-${i}`, rubric: 'factually_consistent', score: true });
        }
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(5);
        expect(result.totalScoredCells).toBe(110);
        // Pooled rate: 5/110 ≈ 4.5%, under tolerance.
        expect(result.regressionRate).toBeLessThan(REGRESSION_RATE_TOLERANCE);
        // But the slice `small::citation_present` is 100%.
        const failingSlice = result.slices.find(
            (s) => s.dataset === 'small' && s.rubric === 'citation_present',
        );
        expect(failingSlice).toBeDefined();
        expect(failingSlice!.regressionRate).toBe(1);
        expect(failingSlice!.underTolerance).toBe(false);
        // Gate fails despite the favorable pooled rate.
        expect(result.underTolerance).toBe(false);
    });

    it('H7: per-slice rates are computed for every (dataset, rubric) baselined pair', () => {
        // Two datasets × two rubrics = 4 slices, all clean.
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                a: { cases: { 'c-0': { citation_present: true, factually_consistent: true } } },
                b: { cases: { 'c-0': { citation_present: true, factually_consistent: true } } },
            },
        };
        const live: LiveCell[] = [];
        for (const dataset of ['a', 'b']) {
            live.push({ dataset, caseId: 'c-0', rubric: 'citation_present', score: true });
            live.push({ dataset, caseId: 'c-0', rubric: 'factually_consistent', score: true });
        }
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.slices).toHaveLength(4);
        // Sorted by (dataset, rubric) for stable assertions.
        const keys = result.slices.map((s) => `${s.dataset}::${s.rubric}`);
        expect(keys).toEqual([
            'a::citation_present',
            'a::factually_consistent',
            'b::citation_present',
            'b::factually_consistent',
        ]);
        for (const s of result.slices) {
            expect(s.totalScoredCells).toBe(1);
            expect(s.flippedCells).toBe(0);
            expect(s.regressionRate).toBe(0);
            expect(s.underTolerance).toBe(true);
        }
    });

    it('M15: a baselined case with zero live cells fails the gate (case removal)', () => {
        // Two cases, both baseline-clean. Live drops case-1 entirely.
        // Without M15 this would slip past today's missing-from-live
        // check because all baseline cells are `true` and the cell
        // count drops symmetrically. With M15 we explicitly flag the
        // missing case as a structural removal.
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                d: {
                    cases: {
                        'case-0': { citation_present: true },
                        'case-1': { citation_present: true },
                    },
                },
            },
        };
        const live: LiveCell[] = [
            { dataset: 'd', caseId: 'case-0', rubric: 'citation_present', score: true },
            // case-1: gone
        ];
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.removedBaselineCases).toEqual([{ dataset: 'd', caseId: 'case-1' }]);
        expect(result.underTolerance).toBe(false);
    });

    it('M15: a vendor-skipped case is NOT counted as removed', () => {
        // Skipped cases are excluded from the surface entirely; they
        // shouldn't trigger the removal alarm.
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                d: { cases: { 'case-0': { citation_present: true } } },
            },
        };
        const skipped = new Set<string>(['d::case-0']);
        const result = compareLiveAgainstBaseline(baseline, [], skipped);
        expect(result.removedBaselineCases).toHaveLength(0);
    });

    it('M15: a baseline-false case that disappears is also flagged (cell-level missing-from-live wouldn\'t catch it)', () => {
        // The pre-M15 gate intentionally did not punish baseline-`false`
        // cells for going missing. That created a hole: a case made up
        // entirely of baseline-`false` cells could disappear silently.
        // M15 closes that gap structurally.
        const baseline: BaselineFile = {
            version: 1,
            committedAt: '2026-01-01T00:00:00.000Z',
            commitSha: null,
            datasets: {
                d: {
                    cases: {
                        'case-0': { citation_present: true },
                        'case-baseline-false': { citation_present: false },
                    },
                },
            },
        };
        const live: LiveCell[] = [
            { dataset: 'd', caseId: 'case-0', rubric: 'citation_present', score: true },
            // case-baseline-false: gone
        ];
        const result = compareLiveAgainstBaseline(baseline, live, new Set());
        expect(result.flipped).toHaveLength(0); // no baseline-true cell flipped
        expect(result.removedBaselineCases).toEqual([
            { dataset: 'd', caseId: 'case-baseline-false' },
        ]);
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
                slices: [],
                removedBaselineCases: [],
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
                slices: [],
                removedBaselineCases: [],
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
                slices: [],
                removedBaselineCases: [],
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
                slices: [],
                removedBaselineCases: [],
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

    it('H7: failing slices appear in their own section with the slice rate', () => {
        const report = renderMarkdownReport(
            {
                flipped: [],
                skipped: [],
                totalScoredCells: 110,
                regressionRate: 0.045, // pooled passes
                underTolerance: false,
                unknownLiveCells: [],
                slices: [
                    {
                        dataset: 'big',
                        rubric: 'citation_present',
                        totalScoredCells: 50,
                        flippedCells: 0,
                        regressionRate: 0,
                        underTolerance: true,
                    },
                    {
                        dataset: 'small',
                        rubric: 'citation_present',
                        totalScoredCells: 5,
                        flippedCells: 5,
                        regressionRate: 1,
                        underTolerance: false,
                    },
                ],
                removedBaselineCases: [],
            },
            [],
            { totalUsd: 1.0, hardCapUsd: 5.0 },
        );
        expect(report).toContain('Per-(dataset, rubric) slice regressions');
        expect(report).toContain('small::citation_present');
        expect(report).toContain('100.0%');
        // Passing slices stay out of the failing section.
        expect(report).not.toContain('big::citation_present');
    });

    it('M15: removed-cases section names the missing case', () => {
        const report = renderMarkdownReport(
            {
                flipped: [],
                skipped: [],
                totalScoredCells: 1,
                regressionRate: 0,
                underTolerance: false,
                unknownLiveCells: [],
                slices: [],
                removedBaselineCases: [
                    { dataset: 'clinical-copilot-briefing-graph-v1', caseId: 'archetype:diabetic' },
                ],
            },
            [],
            { totalUsd: 0.5, hardCapUsd: 5.0 },
        );
        expect(report).toContain('Removed baseline cases');
        expect(report).toContain('clinical-copilot-briefing-graph-v1::archetype:diabetic');
    });
});

type RunGateOptions = NonNullable<Parameters<typeof runGate>[0]>;

describe('runGate (M16: report persisted to disk)', () => {
    let tmpRoot: string;
    const ORIGINAL_LANGSMITH_KEY = process.env['LANGSMITH_API_KEY'];

    // Stub shapes match the runExperiment / Client surface runGate uses.
    // We declare them as plain async functions; the production seam types
    // accept anything callable with the same arity, so explicit casts at
    // each call site keep the test free of nested `Parameters<...>` chains.
    const fakeExperimentRunner = () =>
        Promise.resolve({
            ranExperiment: true as const,
            results: [
                {
                    suiteName: 'demo',
                    datasetName: 'demo-dataset-v1',
                    experimentName: 'demo-experiment-1',
                },
            ],
        });

    const fakeClientFactory = (): unknown => ({});

    beforeEach(async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'eval-gate-test-'));
        process.env['LANGSMITH_API_KEY'] = 'test-key-not-used';
    });

    afterEach(async () => {
        if (ORIGINAL_LANGSMITH_KEY === undefined) {
            delete process.env['LANGSMITH_API_KEY'];
        } else {
            process.env['LANGSMITH_API_KEY'] = ORIGINAL_LANGSMITH_KEY;
        }
        await rm(tmpRoot, { recursive: true, force: true });
    });

    it('writes the rendered markdown to reportPath after a passing run', async () => {
        const baselinePath = join(tmpRoot, 'baseline.json');
        const reportPath = join(tmpRoot, 'eval-gate-report.md');
        await writeFile(
            baselinePath,
            JSON.stringify({
                version: 1,
                committedAt: '2026-01-01T00:00:00.000Z',
                commitSha: null,
                datasets: {
                    'demo-dataset-v1': {
                        cases: { 'case-0': { citation_present: true } },
                    },
                },
            }),
            'utf8',
        );

        const result = await runGate({
            baselinePath,
            reportPath,
            vendorReports: [],
            estimateCostImpl: () =>
                Promise.resolve({
                    perSuite: {},
                    totalUsd: 0.5,
                    hardCapUsd: 5,
                    underCap: true,
                }),
            runExperimentImpl: fakeExperimentRunner as unknown as NonNullable<RunGateOptions['runExperimentImpl']>,
            clientFactory: fakeClientFactory as NonNullable<RunGateOptions['clientFactory']>,
            cellCollector: () =>
                Promise.resolve<readonly LiveCell[]>([
                    {
                        dataset: 'demo-dataset-v1',
                        caseId: 'case-0',
                        rubric: 'citation_present',
                        score: true,
                    },
                ]),
        });

        expect(result.compare.underTolerance).toBe(true);
        // The report file exists and matches what runGate returned.
        const written = await readFile(reportPath, 'utf8');
        expect(written.trim()).toBe(result.markdown.trim());
        expect(written).toContain('Eval gate passed');
    });

    it('still writes the report when the gate fails (so the artifact captures the verdict)', async () => {
        const baselinePath = join(tmpRoot, 'baseline.json');
        const reportPath = join(tmpRoot, 'eval-gate-report.md');
        await writeFile(
            baselinePath,
            JSON.stringify({
                version: 1,
                committedAt: '2026-01-01T00:00:00.000Z',
                commitSha: null,
                datasets: {
                    'demo-dataset-v1': {
                        cases: {
                            'case-0': { citation_present: true },
                            'case-1': { citation_present: true },
                        },
                    },
                },
            }),
            'utf8',
        );

        const result = await runGate({
            baselinePath,
            reportPath,
            vendorReports: [],
            estimateCostImpl: () =>
                Promise.resolve({
                    perSuite: {},
                    totalUsd: 0.5,
                    hardCapUsd: 5,
                    underCap: true,
                }),
            runExperimentImpl: fakeExperimentRunner as unknown as NonNullable<RunGateOptions['runExperimentImpl']>,
            clientFactory: fakeClientFactory as NonNullable<RunGateOptions['clientFactory']>,
            cellCollector: () =>
                // Both cases flipped → 100% regression.
                Promise.resolve<readonly LiveCell[]>([
                    { dataset: 'demo-dataset-v1', caseId: 'case-0', rubric: 'citation_present', score: false },
                    { dataset: 'demo-dataset-v1', caseId: 'case-1', rubric: 'citation_present', score: false },
                ]),
        });

        expect(result.compare.underTolerance).toBe(false);
        const written = await readFile(reportPath, 'utf8');
        expect(written).toContain('Eval gate failed');
    });
});
