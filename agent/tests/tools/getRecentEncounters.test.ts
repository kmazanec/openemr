import { describe, expect, it } from 'vitest';

import { getRecentEncounters } from '../../src/tools/getRecentEncounters.js';
import { SnapshotHttpError, SnapshotNetworkError } from '../../src/tools/snapshotClient.js';
import { mockClientRejecting, mockClientResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const PID = 42;

const baseSnapshot = {
    patient: {
        pid: PID,
        uuid: 'u',
        displayName: 'P',
        sex: null,
        dateOfBirth: null,
        source: { system: 'openemr', recordType: 'Patient', recordId: '42' },
    },
    appointment: null,
    diagnoses: [],
    medications: [],
    allergies: [],
    labs: [],
    encounters: [
        {
            encounterDate: '2026-03-01',
            type: 'Office Visit',
            reason: 'Diabetes follow-up',
            source: { system: 'openemr', recordType: 'Encounter', recordId: 'enc-1' },
        },
    ],
};

describe('getRecentEncounters', () => {
    it('requests only the encounter category from the snapshot endpoint', async () => {
        const { client, fetch } = mockClientResolving(baseSnapshot);

        const result = await getRecentEncounters({ client, token: TOKEN, pid: PID });

        expect(fetch).toHaveBeenCalledWith({
            pid: PID,
            categories: ['encounter'],
            token: TOKEN,
        });
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.encounters).toHaveLength(1);
            expect(result.encounters[0]!.type).toBe('Office Visit');
        }
    });

    it('returns an explicit gap on 5xx', async () => {
        const { client } = mockClientRejecting(new SnapshotHttpError(503, ''));

        const result = await getRecentEncounters({ client, token: TOKEN, pid: PID });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/encounters.*not available/i);
        }
    });

    it('returns an explicit gap on network error', async () => {
        const { client } = mockClientRejecting(new SnapshotNetworkError('unreachable'));

        const result = await getRecentEncounters({ client, token: TOKEN, pid: PID });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors', async () => {
        const { client } = mockClientRejecting(new SnapshotHttpError(403, ''));
        await expect(
            getRecentEncounters({ client, token: TOKEN, pid: PID }),
        ).rejects.toBeInstanceOf(SnapshotHttpError);
    });
});
