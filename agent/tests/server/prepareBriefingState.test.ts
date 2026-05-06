import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { prepareBriefingState } from '../../src/server/prepareBriefingState.js';
import type { RequestEnvelope } from '../../src/graph/types.js';
import { createInMemoryConversationMessagesStore } from '../../src/state/conversationMessages.js';

const buildEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
    ...overrides,
});

const silentLogger = (): Logger =>
    ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }) as unknown as Logger;

describe('prepareBriefingState', () => {
    it('returns the canonical briefing-state seed for a default_briefing envelope', async () => {
        // The helper replaces the W1 loadState/planContext graph nodes:
        // for a UC1 turn the only invariant they enforced was that the
        // task is one of the known kinds, with the rest of the slots
        // initialized to their defaults by the StateAnnotation.
        const envelope = buildEnvelope({ conversationId: 'conv-canonical' });

        const seed = await prepareBriefingState({ envelope });

        expect(seed.envelope).toBe(envelope);
        expect(seed.priorTurnContext).toEqual({ turns: [] });
    });

    it('passes follow_up envelopes through unchanged', async () => {
        const envelope = buildEnvelope({
            task: 'follow_up',
            question: 'Are they on metformin?',
        });

        const seed = await prepareBriefingState({ envelope });

        expect(seed.envelope).toBe(envelope);
        expect(seed.priorTurnContext).toEqual({ turns: [] });
    });

    it('rejects unknown tasks so future task types fail loud', async () => {
        // Carry-forward of the W1 planContext guard: the route boundary
        // already Zod-validates `task`, but defense-in-depth at the
        // runner layer means a bypass route or a stale TS build can't
        // smuggle an unknown task into the graph.
        const bad = buildEnvelope({ task: 'unknown' as never });

        await expect(prepareBriefingState({ envelope: bad })).rejects.toThrow(/unknown.*task/i);
    });

    it('always returns empty turns for default_briefing even when prior messages exist', async () => {
        // §A.5: default-briefing turns mint a fresh conversation row,
        // so by definition there is no prior context to load — the
        // helper short-circuits without touching the messages store.
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'should-not-be-touched',
            role: 'user',
            text: 'leftover from a prior thread',
        });
        const envelope = buildEnvelope({ task: 'default_briefing' });

        const seed = await prepareBriefingState({
            envelope,
            conversationMessages: store,
            logger: silentLogger(),
        });

        expect(seed.priorTurnContext).toEqual({ turns: [] });
    });

    it('projects prior turns into priorTurnContext for follow_up envelopes', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'conv-follow',
            role: 'user',
            text: 'previous question',
        });
        await store.append({
            conversationId: 'conv-follow',
            role: 'assistant',
            message: {
                segments: [
                    {
                        text: 'previous answer',
                        claims: [
                            {
                                id: 'c-1',
                                text: 'has diabetes',
                                category: 'diagnosis',
                                sourceReferences: [
                                    {
                                        source_type: 'chart',
                                        source_id: 'dx-1',
                                        locator: { field: 'condition.code' },
                                        quote: 'dx-1',
                                    },
                                ],
                                safetyCritical: false,
                            },
                        ],
                        redacted: false,
                    },
                ],
                claimGroups: {},
                gaps: [],
                suggestedFollowUps: [],
                archetypeFlags: [],
            },
        });
        await store.append({
            conversationId: 'conv-follow',
            role: 'user',
            text: 'is that getting worse?',
        });
        const envelope = buildEnvelope({
            task: 'follow_up',
            conversationId: 'conv-follow',
            question: 'is that getting worse?',
        });

        const seed = await prepareBriefingState({
            envelope,
            conversationMessages: store,
            logger: silentLogger(),
        });

        // Trailing 'is that getting worse?' is the runner's pre-graph
        // append and gets stripped; the prior user/assistant pair survives.
        expect(seed.priorTurnContext.turns).toHaveLength(2);
        expect(seed.priorTurnContext.turns[0]).toEqual({
            role: 'user',
            text: 'previous question',
        });
        expect(seed.priorTurnContext.turns[1]?.role).toBe('assistant');
    });
});
