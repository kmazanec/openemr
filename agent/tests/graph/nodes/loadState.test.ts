import { describe, expect, it } from 'vitest';

import { loadState } from '../../../src/graph/nodes/loadState.js';
import type { RequestEnvelope } from '../../../src/graph/types.js';

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

describe('loadState', () => {
    it('is a passthrough until §3.5 wires conversation persistence', async () => {
        // ARCHITECTURE.md §"Node Responsibilities": LoadState reads
        // conversation history from Postgres. Phase 3.5 wires that;
        // this node currently leaves state alone so the graph runs.
        const out = await loadState({ envelope, snapshot: null, draft: null,
            claimLedger: null, verified: null, formatted: null, persisted: null });
        expect(out).toEqual({});
    });
});
