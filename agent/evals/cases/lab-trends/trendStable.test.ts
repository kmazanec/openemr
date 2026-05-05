import { describe, expect, it } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import {
    UC2_ANALYTE,
    buildClient,
    buildLabHistoryFetcher,
    buildSynth,
    historySeries,
    loadUc2Fixture,
    trendClaim,
    trendEnvelope,
} from './_helpers.js';

/**
 * UC2 — A1c trending STABLE (Diabetic archetype).
 *
 * The fixture carries four A1c values hovering 6.9–7.2 over 18
 * months. A faithful "stable" claim must pass; a "trending up" claim
 * with the same source rows must fail (the values are present but
 * the prose contradicts them).
 */

describe('UC2 trend-stable — Diabetic archetype', () => {
    it('accepts a faithful "stable" claim citing every value', async () => {
        const snapshot = loadUc2Fixture('a1c_trend_stable');
        const series = historySeries(snapshot);
        expect(series).not.toBeNull();
        if (series === null) return;

        const recordIds = series.observations.map((o) => o.source.source_id);
        const text = `${UC2_ANALYTE} has been stable: 7.0 on 2024-10-15, 7.1 on 2025-04-15, 6.9 on 2025-10-15, and 7.2 on 2026-04-15.`;

        const { synth } = buildSynth(() => ({
            draft: { segments: [{ text, claimIds: ['t-stable'] }] },
            ledger: {
                claims: [trendClaim({ id: 't-stable', text, recordIds })],
            },
        }));

        const graph = createBriefingGraph({
            retrieveChart: {
                client: buildClient(snapshot),
                token: 'eval-token',
                siteId: 'default',
                fetchLabHistory: buildLabHistoryFetcher(snapshot),
            },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: trendEnvelope(snapshot) });

        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
    });

    it('rejects a "trending up" claim that contradicts the source values\' dates', async () => {
        // The values 7.0, 7.1, 6.9, 7.2 are present in the history,
        // but the model wrote them with the wrong observation dates
        // ("rose from 7.0 on 2025-04-15"…). Each row's observedAt is
        // pinned, so the verifier's date check rejects the claim.
        const snapshot = loadUc2Fixture('a1c_trend_stable');
        const series = historySeries(snapshot);
        expect(series).not.toBeNull();
        if (series === null) return;

        const recordIds = series.observations.map((o) => o.source.source_id);
        const text = `${UC2_ANALYTE} rose from 7.0 on 2025-04-15 to 7.2 on 2024-10-15.`;

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
                fetchLabHistory: buildLabHistoryFetcher(snapshot),
            },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: trendEnvelope(snapshot) });

        expect(out.verified?.passed).toBe(false);
        expect(out.verified?.accepted).toHaveLength(0);
        expect(out.verified?.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });
});
