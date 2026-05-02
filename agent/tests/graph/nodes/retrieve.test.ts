import { describe, expect, it, vi } from 'vitest';

import { createRetrieve } from '../../../src/graph/nodes/retrieve.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';
import {
    SnapshotHttpError,
    SnapshotNetworkError,
} from '../../../src/tools/snapshotClient.js';
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
        source: { system: 'openemr', recordType: 'Patient', recordId: '42' },
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'Moderate',
            source: { system: 'openemr', recordType: 'AllergyIntolerance', recordId: 'a-1' },
        },
    ],
    labs: [],
    encounters: [],
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

describe('createRetrieve (Phase B1: single-fetch briefing path)', () => {
    it('issues exactly one snapshot fetch with the full category set', async () => {
        const { client, fetch } = buildClient(() => baseSnapshot());
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default' });

        await retrieve({
            envelope,
            snapshot: null, draft: null, claimLedger: null,
            verified: null, formatted: null, persisted: null,
        });

        expect(fetch).toHaveBeenCalledTimes(1);
        const [call] = fetch.mock.calls;
        expect(call?.[0].categories).toEqual([
            'diagnosis',
            'prescription',
            'allergy',
            'lab',
            'encounter',
        ]);
        expect(call?.[0].pid).toBe(PID);
        expect(call?.[0].token).toBe(TOKEN);
        expect(call?.[0].siteId).toBe('default');
    });

    it('assembles the snapshot from the decoded payload', async () => {
        const { client } = buildClient(() => baseSnapshot());
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default' });

        const out = await retrieve({
            envelope,
            snapshot: null, draft: null, claimLedger: null,
            verified: null, formatted: null, persisted: null,
        });

        const snap = out.snapshot;
        if (snap === null || snap === undefined) throw new Error('snapshot missing');
        expect(snap.patient.pid).toBe(PID);
        expect(snap.allergies).toHaveLength(1);
        expect(Array.isArray(snap.labs)).toBe(true);
        expect(Array.isArray(snap.encounters)).toBe(true);
    });

    it('propagates HTTP errors from the snapshot endpoint', async () => {
        const { client } = buildClient(() => {
            throw new SnapshotHttpError(503, '');
        });
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default' });

        await expect(
            retrieve({
                envelope,
                snapshot: null, draft: null, claimLedger: null,
                verified: null, formatted: null, persisted: null,
            }),
        ).rejects.toBeInstanceOf(SnapshotHttpError);
    });

    it('propagates network errors from the snapshot endpoint', async () => {
        const { client } = buildClient(() => {
            throw new SnapshotNetworkError('unreachable');
        });
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default' });

        await expect(
            retrieve({
                envelope,
                snapshot: null, draft: null, claimLedger: null,
                verified: null, formatted: null, persisted: null,
            }),
        ).rejects.toBeInstanceOf(SnapshotNetworkError);
    });

    it('records loadChartSnapshot latency on the counters sink when wired', async () => {
        const counters = createInMemoryCounters();
        const { client } = buildClient(() => baseSnapshot());
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default', counters });

        await retrieve({
            envelope,
            snapshot: null, draft: null, claimLedger: null,
            verified: null, formatted: null, persisted: null,
        });

        const snap = counters.snapshot();
        const counter = snap.toolCalls['loadChartSnapshot'];
        expect(counter).toBeDefined();
        expect(counter!.count).toBe(1);
        expect(counter!.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });
});
