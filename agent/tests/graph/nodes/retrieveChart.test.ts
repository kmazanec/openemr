import { describe, expect, it, vi } from 'vitest';

import { createRetrieveChart } from '../../../src/graph/nodes/retrieveChart.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';
import {
    SnapshotHttpError,
    SnapshotNetworkError,
} from '../../../src/tools/snapshotClient.js';
import type {
    BriefingState,
    BriefingStateUpdate,
} from '../../../src/graph/state.js';
import type { RequestEnvelope } from '../../../src/graph/types.js';

const TOKEN = 'tok';
const PID = 42;

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'default_briefing',
};

const baseSnapshot = (overrides: Record<string, unknown> = {}): unknown => ({
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        source: { source_type: 'chart' as const, source_id: '42', locator: { field: 'patient.name' }, quote: '42' },
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'Moderate',
            source: { source_type: 'chart' as const, source_id: 'a-1', locator: { field: 'allergy.substance' }, quote: 'a-1' },
        },
    ],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    ...overrides,
});

type FetchSpy = ReturnType<typeof vi.fn<SnapshotClient['fetchSnapshot']>>;

const buildClient = (
    behavior: (input: { categories: readonly string[] }) => unknown,
): { client: SnapshotClient; fetch: FetchSpy } => {
    const fetch: FetchSpy = vi.fn((input) =>
        // Wrap in `new Promise` so synchronous throws inside `behavior`
        // become rejected promises — matches how real `fetchSnapshot` reports
        // errors.
        new Promise<unknown>((resolve) => {
            resolve(behavior(input));
        }),
    );
    return { client: { fetchSnapshot: fetch }, fetch };
};

const firstCallState = (): BriefingState => ({
    envelope,
    priorTurnContext: { turns: [] },
    snapshot: null,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 0,
    retrieveChartArgs: null,    documentEvidenceArgs: null,    documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,    evidenceRetrieverArgs: null,    evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false, kickoffExtractionResults: [],
});

describe('createRetrieveChart (§A.4)', () => {
    describe('first call — deterministic W1 fan-out', () => {
        it('issues exactly one snapshot fetch with the full category set', async () => {
            const { client, fetch } = buildClient(() => baseSnapshot());
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            await retrieve(firstCallState());

            expect(fetch).toHaveBeenCalledTimes(1);
            const [call] = fetch.mock.calls;
            expect(call?.[0].categories).toEqual([
                'diagnosis',
                'prescription',
                'allergy',
                'lab',
                'encounter',
                'reminder',
                'medication_statement',
            ]);
            expect(call?.[0].pid).toBe(PID);
            expect(call?.[0].token).toBe(TOKEN);
            expect(call?.[0].siteId).toBe('default');
        });

        it('assembles the snapshot from the decoded payload and bumps the call counter', async () => {
            const { client } = buildClient(() => baseSnapshot());
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            const out = await retrieve(firstCallState());

            const snap = out.snapshot;
            if (snap === null || snap === undefined) throw new Error('snapshot missing');
            expect(snap.patient.pid).toBe(PID);
            expect(snap.allergies).toHaveLength(1);
            expect(Array.isArray(snap.labs)).toBe(true);
            expect(Array.isArray(snap.encounters)).toBe(true);
            expect(out.retrieveChartCallCount).toBe(1);
        });

        it('propagates HTTP errors from the snapshot endpoint', async () => {
            const { client } = buildClient(() => {
                throw new SnapshotHttpError(503, '');
            });
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            await expect(retrieve(firstCallState())).rejects.toBeInstanceOf(SnapshotHttpError);
        });

        it('propagates network errors from the snapshot endpoint', async () => {
            const { client } = buildClient(() => {
                throw new SnapshotNetworkError('unreachable');
            });
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            await expect(retrieve(firstCallState())).rejects.toBeInstanceOf(SnapshotNetworkError);
        });

        it('records loadChartSnapshot latency on the counters sink when wired', async () => {
            const counters = createInMemoryCounters();
            const { client } = buildClient(() => baseSnapshot());
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default', counters });

            await retrieve(firstCallState());

            const snap = counters.snapshot();
            const counter = snap.toolCalls['loadChartSnapshot'];
            expect(counter).toBeDefined();
            expect(counter!.count).toBe(1);
            expect(counter!.totalLatencyMs).toBeGreaterThanOrEqual(0);
        });
    });

    describe('subsequent call — model-driven narrowing', () => {
        const stateAfterFirstCall = (firstUpdate: BriefingStateUpdate): BriefingState => {
            const snapshot = firstUpdate.snapshot;
            if (snapshot === null || snapshot === undefined) {
                throw new Error('first call did not populate snapshot');
            }
            return {
                envelope,
                priorTurnContext: { turns: [] },
                snapshot,
                draft: null,
                claimLedger: null,
                verified: null,
                formatted: null,
                persisted: null,
                retrieveChartCallCount: 1,
                retrieveChartArgs: null,                documentEvidenceArgs: null,                documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,                evidenceRetrieverArgs: null,                evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false, kickoffExtractionResults: [],
            };
        };

        it('honors args.categories and translates `medication` to the snapshot client `prescription`', async () => {
            const { client, fetch } = buildClient(() => baseSnapshot());
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            const first = await retrieve(firstCallState());
            const second = await retrieve({
                ...stateAfterFirstCall(first),
                retrieveChartArgs: { categories: ['medication', 'lab'] },
            });

            expect(fetch).toHaveBeenCalledTimes(2);
            expect(fetch.mock.calls[1]?.[0].categories).toEqual(['prescription', 'lab']);
            expect(second.retrieveChartCallCount).toBe(2);
        });

        it('rejects an empty args.categories list at the node entry', async () => {
            const { client, fetch } = buildClient(() => baseSnapshot());
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            const first = await retrieve(firstCallState());
            await expect(
                retrieve({
                    ...stateAfterFirstCall(first),
                    retrieveChartArgs: { categories: [] },
                }),
            ).rejects.toThrow(/categories/);
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        it('throws when retrieveChartArgs is null on a subsequent call', async () => {
            const { client } = buildClient(() => baseSnapshot());
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            const first = await retrieve(firstCallState());
            await expect(
                retrieve(stateAfterFirstCall(first)),
            ).rejects.toThrow(/retrieveChartArgs/);
        });

        it('preserves first-call snapshot slots the supervisor did not re-request', async () => {
            // First call populates allergies; supervisor narrows to lab
            // only; the empty allergies array the snapshot endpoint
            // returns must NOT clobber the populated allergies slot.
            const calls: { categories: readonly string[] }[] = [];
            const fetch = vi.fn((input: { categories: readonly string[] }) => {
                calls.push(input);
                if (calls.length === 1) {
                    return Promise.resolve(baseSnapshot());
                }
                // Narrow request: snapshot endpoint returns the same
                // structural shape but every slot the request didn't
                // ask for is empty (matches PhiMinimizer behavior).
                return Promise.resolve(baseSnapshot({ allergies: [] }));
            }) as unknown as SnapshotClient['fetchSnapshot'];
            const client: SnapshotClient = { fetchSnapshot: fetch };
            const retrieve = createRetrieveChart({ client, token: TOKEN, siteId: 'default' });

            const first = await retrieve(firstCallState());
            const second = await retrieve({
                ...stateAfterFirstCall(first),
                retrieveChartArgs: { categories: ['lab'] },
            });

            expect(second.snapshot?.allergies).toHaveLength(1);
        });
    });
});
