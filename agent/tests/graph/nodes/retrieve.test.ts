import { describe, expect, it, vi } from 'vitest';

import { createRetrieve } from '../../../src/graph/nodes/retrieve.js';
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
    medications: [],
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

const buildClient = (
    behavior: (categories: readonly string[]) => unknown,
): SnapshotClient => ({
    fetchSnapshot: vi.fn((input: { categories: readonly string[] }) =>
        // Wrap in `new Promise` so synchronous throws inside `behavior`
        // become rejected promises — matches how real `fetchSnapshot` reports
        // errors, and lets the fail-closed/fail-open tests stay synchronous.
        new Promise<unknown>((resolve) => {
            resolve(behavior(input.categories));
        }),
    ),
});

describe('createRetrieve', () => {
    it('fans out to all four §3.1 tools and assembles the snapshot', async () => {
        const client = buildClient(() => baseSnapshot());
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

    it('records labs as a gap when the labs tool fails open', async () => {
        const client = buildClient((categories) => {
            if (categories.includes('lab')) {
                throw new SnapshotHttpError(503, '');
            }
            return baseSnapshot();
        });
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default' });

        const out = await retrieve({
            envelope,
            snapshot: null, draft: null, claimLedger: null,
            verified: null, formatted: null, persisted: null,
        });

        expect(out.snapshot?.labs).toMatchObject({
            kind: 'gap',
            reason: 'endpoint-unavailable',
        });
    });

    it('records encounters as a gap when the encounters tool fails open', async () => {
        const client = buildClient((categories) => {
            if (categories.includes('encounter')) {
                throw new SnapshotNetworkError('unreachable');
            }
            return baseSnapshot();
        });
        const retrieve = createRetrieve({ client, token: TOKEN, siteId: 'default' });

        const out = await retrieve({
            envelope,
            snapshot: null, draft: null, claimLedger: null,
            verified: null, formatted: null, persisted: null,
        });

        expect(out.snapshot?.encounters).toMatchObject({
            kind: 'gap',
            reason: 'endpoint-unreachable',
        });
    });

    it('propagates fail-closed errors from getPatientContext (allergies fail-closed)', async () => {
        const client = buildClient((categories) => {
            if (categories.includes('allergy')) {
                throw new SnapshotHttpError(503, '');
            }
            return baseSnapshot();
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

    it('propagates fail-closed errors from getMedications', async () => {
        const client = buildClient((categories) => {
            if (categories.includes('medication')) {
                throw new SnapshotNetworkError('unreachable');
            }
            return baseSnapshot();
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
});
