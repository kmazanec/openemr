import { describe, expect, it } from 'vitest';

import { getMedications } from '../../src/tools/getMedications.js';
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
    medications: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            source: { system: 'openemr', recordType: 'MedicationRequest', recordId: 'rx-1' },
        },
    ],
    allergies: [],
    labs: [],
    encounters: [],
};

describe('getMedications', () => {
    it('requests only the medication category from the snapshot endpoint', async () => {
        const { client, fetch } = mockClientResolving(baseSnapshot);

        const out = await getMedications({ client, token: TOKEN, siteId: SITE, pid: PID });

        expect(fetch).toHaveBeenCalledWith({
            pid: PID,
            categories: ['medication'],
            token: TOKEN,
            siteId: SITE,
        });
        expect(out).toHaveLength(1);
        expect(out[0]!.name).toBe('Metformin');
    });

    it('fails closed on HTTP error', async () => {
        const { client } = mockClientRejecting(new SnapshotHttpError(503, ''));
        await expect(getMedications({ client, token: TOKEN, siteId: SITE, pid: PID })).rejects.toBeInstanceOf(
            SnapshotHttpError,
        );
    });

    it('fails closed on network error', async () => {
        const { client } = mockClientRejecting(new SnapshotNetworkError('unreachable'));
        await expect(getMedications({ client, token: TOKEN, siteId: SITE, pid: PID })).rejects.toBeInstanceOf(
            SnapshotNetworkError,
        );
    });
});
