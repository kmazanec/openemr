import { describe, expect, it } from 'vitest';

import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';
import type { Claim } from '../../src/graph/types.js';

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const claim: Claim = {
    id: 'c-1',
    text: 'Patient has type 2 diabetes',
    category: 'diagnosis',
    sourceReferences: [sourceRef('Condition', 'c-MISSING')],
    safetyCritical: false,
};

describe('createNullUnverifiedClaimsLog', () => {
    it('setup and record both resolve without touching any database', async () => {
        const log = createNullUnverifiedClaimsLog();
        await expect(log.setup()).resolves.toBeUndefined();
        await expect(
            log.record([
                {
                    context: { requestId: 'r-1', conversationId: 'conv-1' },
                    claim,
                    reason: 'source-record-not-in-snapshot',
                },
            ]),
        ).resolves.toBeUndefined();
    });

    it('record on an empty batch is a no-op', async () => {
        const log = createNullUnverifiedClaimsLog();
        await expect(log.record([])).resolves.toBeUndefined();
    });
});
