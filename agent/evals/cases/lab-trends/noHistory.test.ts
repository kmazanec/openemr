import { describe, expect, it } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import {
    UC2_ANALYTE,
    buildClient,
    buildSynth,
    historySeries,
    loadUc2Fixture,
    trendEnvelope,
} from './_helpers.js';

/**
 * UC2 — no history available.
 *
 * The fixture's `labHistory.observations` is empty. The prompt tells
 * the model to NOT assert a trend in this case ("only one A1c on
 * file" / "no A1c on file in the last two years"). If a future model
 * regression slips an unsourced trend assertion through, the
 * verifier must still drop it — that's what this case pins.
 */

describe('UC2 no-history — Healthy-Adult archetype', () => {
    it('accepts a no-data acknowledgement segment with empty claimIds', async () => {
        // A faithful "no-data" turn emits a single segment whose
        // text acknowledges the gap and whose `claimIds` is empty.
        // The verifier doesn't see any claims to score, so the turn
        // passes through cleanly.
        const snapshot = loadUc2Fixture('no_lab_history');
        const series = historySeries(snapshot);
        expect(series).not.toBeNull();
        expect(series?.observations).toHaveLength(0);

        const { synth } = buildSynth(() => ({
            draft: {
                segments: [
                    {
                        text: `No ${UC2_ANALYTE} values are on file in the last two years.`,
                        claimIds: [],
                    },
                ],
            },
            ledger: { claims: [] },
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

        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(0);
        expect(out.verified?.rejected).toHaveLength(0);
    });

    it('rejects a hallucinated trend claim that cites a record id not in the empty history', async () => {
        // Adversarial: the model invents a value AND a record id
        // when the chart has none. The §3.3 verifier already rejects
        // this on `source-record-not-in-snapshot`; pinning it here
        // proves the UC2 path inherits the same defense.
        const snapshot = loadUc2Fixture('no_lab_history');

        const text = `${UC2_ANALYTE} was 7.4 on 2026-04-15.`;
        const { synth } = buildSynth(() => ({
            draft: { segments: [{ text, claimIds: ['t-hallucinated'] }] },
            ledger: {
                claims: [
                    {
                        id: 't-hallucinated',
                        text,
                        category: 'lab' as const,
                        sourceReferences: [
                            {
                                source_type: 'chart',
                                source_id: 'obs-FABRICATED',
                                locator: { field: 'observation.value' },
                                quote: 'obs-FABRICATED',
                            },
                        ],
                        safetyCritical: false,
                    },
                ],
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
        expect(out.verified?.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});
