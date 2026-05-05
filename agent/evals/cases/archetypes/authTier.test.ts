import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import { SnapshotHttpError } from '../../../src/tools/snapshotClient.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §6.6 authorization-tier evals. PRESEARCH §12 commits to OpenEMR's
 * three-tier ACL model (physician / nurse / admin). The §3.6
 * `crossPatient.test.ts` case pins one specific 403 reason
 * (cross-patient pid). This file pins the broader property — *any*
 * 403 the snapshot proxy returns must short-circuit before the
 * synthesizer is invoked, so the agent burns zero tokens regardless
 * of which RBAC tier triggered the deny.
 *
 * Which principal triggers which 403 is a PHP-side determination
 * covered by `tests/Tests/Isolated/Modules/ClinicalCopilot/`. The
 * agent-side property is principal-agnostic. We parameterize across
 * the two specific reasons the §6.6 spec calls out (a nurse without
 * ACL on the chart, a physician querying outside their assigned
 * panel) and assert each one fails closed identically.
 *
 * Note: The §6.6 plan checkbox references "the seeded role users
 * from `db/seeds/`" — that wording is stale. The current
 * `baseline.sql.gz` ships only admin/clinician/portal/phimail/
 * accountant; no nurse, no physician panel separation. This eval
 * stays at the agent layer where the property is observable from a
 * fixture-only setup.
 */

interface DenialCase {
    readonly reason: string;
    readonly responseBody: string;
}

const DENIALS: readonly DenialCase[] = [
    {
        reason: 'nurse_without_acl',
        responseBody: '{"error":"acl_denied","tier":"nurse"}',
    },
    {
        reason: 'physician_off_panel',
        responseBody: '{"error":"acl_denied","tier":"physician","panel":"off"}',
    },
];

describe.each(DENIALS)('UC1 auth-tier — $reason', ({ responseBody }) => {
    it('graph fails before invoking the synthesizer (0 model calls, 0 token cost)', async () => {
        const snapshot = loadFixture('diabetic');
        const envelope = baseEnvelope(snapshot);

        const forbiddenClient: SnapshotClient = {
            fetchSnapshot: vi.fn(() =>
                Promise.reject(new SnapshotHttpError(403, responseBody)),
            ),
        };

        const { synth, mock: synthMock } = buildFaithfulSynth();
        const counters = createInMemoryCounters();

        const graph = createBriefingGraph({
            retrieveChart: {
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
