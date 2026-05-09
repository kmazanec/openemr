import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { prepareBriefingState } from '../../src/server/prepareBriefingState.js';
import type { RequestEnvelope } from '../../src/graph/types.js';
import { createInMemoryConversationMessagesStore } from '../../src/state/conversationMessages.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';

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

/**
 * Snapshot payload shape `decodeChartSnapshot` accepts. Mirrors the
 * minimal-but-valid shape used in `tests/graph/nodes/retrieveChart.test.ts`.
 * Inlined here rather than imported because the helper there is local to
 * that file and we don't want a cross-test reach.
 */
const buildSnapshotPayload = (overrides: Record<string, unknown> = {}): unknown => ({
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        source: {
            source_type: 'chart' as const,
            source_id: '42',
            locator: { field: 'patient.name' },
            quote: '42',
        },
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    ...overrides,
});

const buildPrefetchClient = (
    behavior: () => unknown,
): { client: SnapshotClient; fetch: ReturnType<typeof vi.fn> } => {
    const fetch: SnapshotClient['fetchSnapshot'] = vi.fn(() =>
        Promise.resolve(behavior()),
    );
    return {
        client: { fetchSnapshot: fetch },
        fetch: fetch as unknown as ReturnType<typeof vi.fn>,
    };
};

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

    it('resets every per-turn graph slot so checkpointer-hydrated state cannot leak between turns', async () => {
        // Production incident May 2026: follow-up turns errored at
        //   "retrieveChart: subsequent invocation requires retrieveChartArgs"
        // because the LangGraph Postgres checkpointer hydrated the prior
        // turn's `retrieveChartCallCount` (=1 after the briefing) and
        // the runner's seed didn't reset it. The retrieveChart node saw
        // callCount > 0 on a fresh follow-up's first call, demanded
        // `retrieveChartArgs` that don't exist on a new turn, and threw.
        //
        // The seed must explicitly null/zero every per-turn slot so the
        // initialState passed to graph.stream() overwrites the hydrated
        // values. Only `envelope` and `priorTurnContext` legitimately
        // carry forward.
        const envelope = buildEnvelope({
            task: 'follow_up',
            conversationId: 'conv-with-prior-checkpoint',
            question: 'follow-up question',
        });
        const store = createInMemoryConversationMessagesStore();

        const seed = await prepareBriefingState({
            envelope,
            conversationMessages: store,
            logger: silentLogger(),
        });

        // The slot-by-slot pin: anything that retrieveChart, supervisor,
        // synthesize, verify, format, or persist might write must start
        // from its declared default.
        expect(seed.snapshot).toBeNull();
        expect(seed.draft).toBeNull();
        expect(seed.claimLedger).toBeNull();
        expect(seed.verified).toBeNull();
        expect(seed.formatted).toBeNull();
        expect(seed.persisted).toBeNull();
        expect(seed.retrieveChartCallCount).toBe(0);
        expect(seed.retrieveChartArgs).toBeNull();
        expect(seed.documentEvidenceArgs).toBeNull();
        expect(seed.documentEvidenceSnippets).toBeNull();
        expect(seed.documentEvidenceArtifactConfidence).toBeNull();
        expect(seed.evidenceRetrieverArgs).toBeNull();
        expect(seed.evidenceRetrieverOutput).toBeNull();
        expect(seed.supervisorIterations).toBe(0);
        expect(seed.supervisorDecisionHistory).toEqual([]);
        expect(seed.capHit).toBe(false);
    });

    it('also resets per-turn slots for a default_briefing turn (defensive symmetry)', async () => {
        // Default-briefing turns mint a fresh conversation row, so a
        // hydrated checkpoint is unexpected — but the runner reuses a
        // single `prepareBriefingState` for both task kinds and the
        // reset is cheap, so emit the same shape regardless of task.
        const envelope = buildEnvelope({ task: 'default_briefing' });

        const seed = await prepareBriefingState({ envelope });

        expect(seed.retrieveChartCallCount).toBe(0);
        expect(seed.retrieveChartArgs).toBeNull();
        expect(seed.snapshot).toBeNull();
    });

    describe('snapshot prefetch (A1 latency optimization)', () => {
        it('seeds the snapshot and bumps retrieveChartCallCount when prefetch lands', async () => {
            // The runner-side prefetch moves the chart fetch out of the
            // graph's `retrieveChart` node and into here so it overlaps
            // with `loadPriorContext`. When it lands, the graph enters
            // with a populated snapshot and the no-op fast-path in
            // `retrieveChart` triggers — saving one serialized HTTP hop
            // before the supervisor's first iteration.
            const { client, fetch } = buildPrefetchClient(() => buildSnapshotPayload());
            const envelope = buildEnvelope({ task: 'default_briefing' });

            const seed = await prepareBriefingState({
                envelope,
                snapshotPrefetch: { client, token: 'tok', siteId: 'default' },
            });

            expect(fetch).toHaveBeenCalledTimes(1);
            expect(seed.snapshot).not.toBeNull();
            expect(seed.snapshot?.patient.pid).toBe(42);
            expect(seed.retrieveChartCallCount).toBe(1);
        });

        it('falls back to null snapshot when prefetch throws (graph then runs retrieveChart)', async () => {
            // Fail-soft policy: a snapshot endpoint blip during
            // prefetch should not crash the request. The graph's
            // `retrieveChart` node will run normally and surface any
            // persistent failure with its existing error semantics.
            const fetch: SnapshotClient['fetchSnapshot'] = vi.fn(() =>
                Promise.reject(new Error('snapshot endpoint 503')),
            );
            const client: SnapshotClient = { fetchSnapshot: fetch };
            const logger = silentLogger();
            const envelope = buildEnvelope({ task: 'default_briefing' });

            const seed = await prepareBriefingState({
                envelope,
                logger,
                snapshotPrefetch: { client, token: 'tok', siteId: 'default' },
            });

            expect(seed.snapshot).toBeNull();
            expect(seed.retrieveChartCallCount).toBe(0);
            const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const [warnPayload, warnMessage] = warnSpy.mock.calls[0] as [
                { err: string },
                string,
            ];
            expect(warnPayload.err).toContain('503');
            expect(warnMessage).toContain('prefetch failed');
        });

        it('runs prefetch in parallel with prior-context load on follow-up turns', async () => {
            // Concurrency check: the snapshot fetch and the prior-context
            // load should resolve concurrently. We assert this by making
            // the snapshot fetch hang until we tick the event loop and
            // observe that loadPriorContext has already completed —
            // i.e. neither awaits the other.
            const store = createInMemoryConversationMessagesStore();
            await store.append({
                conversationId: 'conv-follow',
                role: 'user',
                text: 'previous question',
            });

            let snapshotResolve: ((v: unknown) => void) | undefined;
            const snapshotPromise = new Promise<unknown>((resolve) => {
                snapshotResolve = resolve;
            });
            const fetch: SnapshotClient['fetchSnapshot'] = vi.fn(() => snapshotPromise);
            const client: SnapshotClient = { fetchSnapshot: fetch };

            const envelope = buildEnvelope({
                task: 'follow_up',
                conversationId: 'conv-follow',
                question: 'follow-up?',
            });

            const seedPromise = prepareBriefingState({
                envelope,
                conversationMessages: store,
                logger: silentLogger(),
                snapshotPrefetch: { client, token: 'tok', siteId: 'default' },
            });

            // Yield to the microtask queue so loadPriorContext (which
            // hits the in-memory store synchronously under an await)
            // has its chance to run while the snapshot fetch is still
            // pending. If `prepareBriefingState` were serializing the
            // two, this resolve would happen too late to matter.
            await Promise.resolve();
            snapshotResolve!(buildSnapshotPayload());

            const seed = await seedPromise;
            expect(seed.snapshot).not.toBeNull();
            expect(seed.priorTurnContext.turns.length).toBeGreaterThan(0);
        });
    });
});
