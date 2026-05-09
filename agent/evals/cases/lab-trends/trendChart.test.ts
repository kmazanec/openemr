import { describe, expect, it } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import {
    UC2_ANALYTE,
    buildClient,
    buildSynth,
    historySeries,
    loadUc2Fixture,
    trendClaim,
    trendEnvelope,
} from './_helpers.js';

/**
 * Trend-chart attachment regression coverage.
 *
 * Once the verifier accepts a trend claim, the format node must also
 * attach a `trendChart` to the assistant message so the panel can
 * render it inline. These cases pin the contract end-to-end through
 * the real graph (snapshot → synthesize stub → verify → format).
 *
 * Stubbed synthesizer (same pattern as `trendUp.test.ts`); the chart
 * decision is deterministic so no model call is needed for this
 * regression layer. The nightly LangSmith experiment exercises the
 * real synthesizer against the same fixtures.
 */

const buildTrendCase = (fixtureName: 'a1c_trend_up' | 'a1c_trend_stable') => {
    const snapshot = loadUc2Fixture(fixtureName);
    const series = historySeries(snapshot);
    if (series === null) throw new Error(`fixture ${fixtureName} has no labHistory`);

    const recordIds = series.observations.map((o) => o.source.source_id);
    // Mirror the value+observedAt-citing pattern that `trendUp.test.ts`
    // proved the verifier accepts; without each value/date in the text
    // the trend claim is rejected and the chart-attachment branch is
    // unreachable. Keep the text deterministic so this case stays a
    // pure regression on the format-side decision, not on the
    // synthesizer.
    const valueDates = series.observations
        .map((o) => `${o.value} on ${o.observedAt ?? ''}`)
        .join(', ');
    const text = `${UC2_ANALYTE} trend: ${valueDates}.`;

    const { synth } = buildSynth(() => ({
        draft: { segments: [{ text, claimIds: ['trend-1'] }] },
        ledger: { claims: [trendClaim({ id: 'trend-1', text, recordIds })] },
    }));

    return { snapshot, synth };
};

describe('trend-chart attachment', () => {
    it('attaches a trend chart on the trending-up A1c fixture', async () => {
        const { snapshot, synth } = buildTrendCase('a1c_trend_up');
        const graph = createBriefingGraph({
            retrieveChart: {
                client: buildClient(snapshot),
                token: 'eval-token',
                siteId: 'default',
            },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: trendEnvelope(snapshot) });

        const chart = out.formatted?.trendChart;
        expect(chart).toBeDefined();
        if (chart === undefined) return;
        expect(chart.analyte).toBe(UC2_ANALYTE);
        // Series matches the fixture's history (4 observations) and
        // the values are sorted ascending by observedAt.
        expect(chart.points.length).toBeGreaterThanOrEqual(4);
        const observedAts = chart.points.map((p) => p.observedAt);
        const sortedCopy = [...observedAts].sort((a, b) => a.localeCompare(b));
        expect(observedAts).toEqual(sortedCopy);
        // Every plotted value is finite (the decision module rejects
        // non-numeric lab values silently).
        expect(chart.points.every((p) => Number.isFinite(p.value))).toBe(true);
        expect(chart.groundedInClaimIds).toEqual(['trend-1']);
    });

    it('attaches a trend chart on the stable A1c fixture as well', async () => {
        const { snapshot, synth } = buildTrendCase('a1c_trend_stable');
        const graph = createBriefingGraph({
            retrieveChart: {
                client: buildClient(snapshot),
                token: 'eval-token',
                siteId: 'default',
            },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: trendEnvelope(snapshot) });

        expect(out.formatted?.trendChart).toBeDefined();
        // The single-chart cap is structural (the wire shape is a
        // single value, not an array) — pinning it here lets a future
        // refactor that inadvertently changes the shape blow up loudly.
        expect(Array.isArray(out.formatted?.trendChart)).toBe(false);
    });
});
