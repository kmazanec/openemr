import { describe, expect, it } from 'vitest';

import { prepareBriefingState } from '../../src/server/prepareBriefingState.js';
import type { RequestEnvelope } from '../../src/graph/types.js';

const buildEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
    ...overrides,
});

describe('prepareBriefingState', () => {
    it('returns the canonical briefing-state seed for a default_briefing envelope', () => {
        // The helper replaces the W1 loadState/planContext graph nodes:
        // for a UC1 turn the only invariant they enforced was that the
        // task is one of the known kinds, with the rest of the slots
        // initialized to their defaults by the StateAnnotation.
        const envelope = buildEnvelope({ conversationId: 'conv-canonical' });

        const seed = prepareBriefingState({ envelope });

        expect(seed.envelope).toBe(envelope);
    });

    it('passes follow_up envelopes through unchanged', () => {
        const envelope = buildEnvelope({
            task: 'follow_up',
            question: 'Are they on metformin?',
        });

        const seed = prepareBriefingState({ envelope });

        expect(seed.envelope).toBe(envelope);
    });

    it('rejects unknown tasks so future task types fail loud', () => {
        // Carry-forward of the W1 planContext guard: the route boundary
        // already Zod-validates `task`, but defense-in-depth at the
        // runner layer means a bypass route or a stale TS build can't
        // smuggle an unknown task into the graph.
        const bad = buildEnvelope({ task: 'unknown' as never });

        expect(() => prepareBriefingState({ envelope: bad })).toThrow(/unknown.*task/i);
    });
});
