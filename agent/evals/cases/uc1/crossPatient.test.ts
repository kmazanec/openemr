import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import { SnapshotHttpError } from '../../../src/tools/snapshotClient.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §3.6 cross-patient ID case. The plan checkbox reads:
 *
 *   "cross-patient ID in envelope → 403 from proxy, 0 tokens spent"
 *
 * The 403 is enforced on the OpenEMR side by `AgentProxyController`
 * (Phase 1.4) before a token is even minted, and re-enforced by
 * `AgentSnapshotController` (Phase 2.6) when the JWT-claimed fhirUser
 * doesn't match the requested pid. Both gates run in PHP and have
 * their own coverage in `tests/Tests/Isolated/Modules/ClinicalCopilot/`.
 *
 * What this eval asserts is the **agent-side** consequence: when the
 * snapshot endpoint returns 403, the briefing graph must propagate the
 * error before calling the synthesizer. That's the "0 tokens spent"
 * guarantee — no model invocation, no cost, no leaked context. We
 * verify it via the synthesizer mock's call count and via the
 * in-memory counters' model-usage tally.
 */

describe('UC1 cross-patient — snapshot endpoint returns 403', () => {
    it('graph fails before invoking the synthesizer (0 model calls, 0 token cost)', async () => {
        const snapshot = loadFixture('diabetic');
        const envelope = baseEnvelope(snapshot);

        const forbiddenClient: SnapshotClient = {
            fetchSnapshot: vi.fn(() =>
                Promise.reject(new SnapshotHttpError(403, '{"error":"acl_denied"}')),
            ),
        };

        const { synth, mock: synthMock } = buildFaithfulSynth();
        const counters = createInMemoryCounters();

        const graph = createBriefingGraph({
            retrieve: {
                client: forbiddenClient,
                token: 'eval-token',
                siteId: 'default',
                counters,
            },
            synthesize: { synthesizer: synth, counters },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog(), counters },
        });

        await expect(graph.invoke({ envelope })).rejects.toBeInstanceOf(SnapshotHttpError);

        expect(synthMock).not.toHaveBeenCalled();

        const tally = counters.snapshot();
        expect(tally.modelUsage).toEqual({});
        expect(tally.verification.passed).toBe(0);
        expect(tally.verification.failed).toBe(0);
    });
});
