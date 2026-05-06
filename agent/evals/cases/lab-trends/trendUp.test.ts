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
 * UC2 — A1c trending UP (Diabetic-Uncontrolled archetype).
 *
 * The fixture carries four A1c values rising 7.2 → 8.1 → 8.7 → 9.4
 * over 24 months. The verifier must accept a trend claim that cites
 * every value to its own source row, and refuse a claim that
 * fabricates a value not in the history.
 */

describe('UC2 trend-up — Diabetic-Uncontrolled archetype', () => {
    it('accepts a faithful "trending up" claim citing every value', async () => {
        const snapshot = loadUc2Fixture('a1c_trend_up');
        const series = historySeries(snapshot);
        expect(series).not.toBeNull();
        if (series === null) return;

        const recordIds = series.observations.map((o) => o.source.source_id);
        const text = `${UC2_ANALYTE} has been trending up: 7.2 on 2024-04-15, 8.1 on 2025-04-15, 8.7 on 2025-10-15, and 9.4 on 2026-04-15.`;

        const { synth } = buildSynth(() => ({
            draft: { segments: [{ text, claimIds: ['t-up'] }] },
            ledger: {
                claims: [trendClaim({ id: 't-up', text, recordIds })],
            },
        }));

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

        expect(out.verified).toBeDefined();
        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.rejected).toHaveLength(0);
    });

    it('rejects a claim that fabricates a value not present in the history', async () => {
        const snapshot = loadUc2Fixture('a1c_trend_up');
        const series = historySeries(snapshot);
        expect(series).not.toBeNull();
        if (series === null) return;

        const recordIds = series.observations.map((o) => o.source.source_id);
        // The fixture's A1c values are 7.2, 8.1, 8.7, 9.4. The model
        // is hallucinating "10.5" — a number that doesn't appear in
        // any cited row. The verifier's strengthened matchesLab must
        // refuse this even though every row resolves.
        const text = `${UC2_ANALYTE} has been trending up sharply, peaking at 10.5% on 2026-04-15.`;

        const { synth } = buildSynth(() => ({
            draft: { segments: [{ text, claimIds: ['t-bad'] }] },
            ledger: {
                claims: [trendClaim({ id: 't-bad', text, recordIds })],
            },
        }));

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

        expect(out.verified?.passed).toBe(false);
        expect(out.verified?.accepted).toHaveLength(0);
        expect(out.verified?.rejected).toHaveLength(1);
        expect(out.verified?.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });
});
