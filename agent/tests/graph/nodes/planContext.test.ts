import { describe, expect, it } from 'vitest';

import { planContext } from '../../../src/graph/nodes/planContext.js';
import type { RequestEnvelope } from '../../../src/graph/types.js';

const envelope = (task: RequestEnvelope['task']): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task,
});

describe('planContext', () => {
    it('routes default_briefing through unchanged for the UC1 path', async () => {
        const out = await planContext({
            envelope: envelope('default_briefing'),
            snapshot: null, draft: null, claimLedger: null,
            verified: null, formatted: null, persisted: null,
        });
        expect(out).toEqual({});
    });

    it('rejects unknown tasks so future task types fail loud', async () => {
        await expect(
            planContext({
                envelope: { ...envelope('default_briefing'), task: 'unknown' as never },
                snapshot: null, draft: null, claimLedger: null,
                verified: null, formatted: null, persisted: null,
            }),
        ).rejects.toThrow(/unknown.*task/i);
    });
});
