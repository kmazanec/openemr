import { describe, expect, it } from 'vitest';

import { getRecentLabs } from '../../src/tools/getRecentLabs.js';
import { SnapshotHttpError, SnapshotNetworkError } from '../../src/tools/snapshotClient.js';
import { mockClientRejecting, mockClientResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
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
    labs: [
        {
            analyte: 'A1c',
            value: '8.4',
            unit: '%',
            referenceRange: '<7.0',
            abnormalFlag: 'H',
            observedAt: '2026-04-15',
            source: { system: 'openemr', recordType: 'Observation', recordId: 'lab-1' },
        },
    ],
    encounters: [],
};

describe('getRecentLabs', () => {
    it('requests only the lab category from the snapshot endpoint', async () => {
        const { client, fetch } = mockClientResolving(baseSnapshot);

        const result = await getRecentLabs({ client, token: TOKEN, siteId: SITE, pid: PID });

        expect(fetch).toHaveBeenCalledWith({
            pid: PID,
            categories: ['lab'],
            token: TOKEN,
            siteId: SITE,
        });
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.labs).toHaveLength(1);
            expect(result.labs[0]!.analyte).toBe('A1c');
        }
    });

    it('returns an explicit gap when the snapshot endpoint returns 5xx', async () => {
        const { client } = mockClientRejecting(new SnapshotHttpError(503, ''));

        const result = await getRecentLabs({ client, token: TOKEN, siteId: SITE, pid: PID });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/labs.*not available/i);
        }
    });

    it('returns an explicit gap when the snapshot endpoint is unreachable', async () => {
        const { client } = mockClientRejecting(new SnapshotNetworkError('unreachable'));

        const result = await getRecentLabs({ client, token: TOKEN, siteId: SITE, pid: PID });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        // 401/403 indicates a misconfigured token, not a transient data
        // problem. Surfacing it as a gap would hide a real failure.
        const { client } = mockClientRejecting(new SnapshotHttpError(401, ''));
        await expect(getRecentLabs({ client, token: TOKEN, siteId: SITE, pid: PID })).rejects.toBeInstanceOf(
            SnapshotHttpError,
        );
    });

    it('returns an empty list as a real result, not a gap', async () => {
        const { client } = mockClientResolving({ ...baseSnapshot, labs: [] });

        const result = await getRecentLabs({ client, token: TOKEN, siteId: SITE, pid: PID });

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.labs).toEqual([]);
        }
    });
});
