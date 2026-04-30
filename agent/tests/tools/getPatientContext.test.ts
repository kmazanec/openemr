import { describe, expect, it } from 'vitest';

import { getPatientContext } from '../../src/tools/getPatientContext.js';
import { SnapshotHttpError, SnapshotNetworkError } from '../../src/tools/snapshotClient.js';
import { mockClientRejecting, mockClientResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;

const baseSnapshot = {
    patient: {
        pid: PID,
        uuid: 'u',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        source: { system: 'openemr', recordType: 'Patient', recordId: '42' },
    },
    appointment: null,
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: { system: 'openemr', recordType: 'Condition', recordId: 'c-1' },
        },
    ],
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
};

describe('getPatientContext', () => {
    it('requests identity, diagnosis, and allergy categories from the snapshot endpoint', async () => {
        const { client, fetch } = mockClientResolving(baseSnapshot);

        const out = await getPatientContext({ client, token: TOKEN, siteId: SITE, pid: PID });

        expect(fetch).toHaveBeenCalledWith({
            pid: PID,
            categories: ['diagnosis', 'allergy'],
            token: TOKEN,
            siteId: SITE,
        });
        expect(out.patient.displayName).toBe('Mrs. Patel');
        expect(out.diagnoses).toHaveLength(1);
        expect(out.allergies).toHaveLength(1);
    });

    it('fails closed when the snapshot endpoint returns an HTTP error', async () => {
        const { client } = mockClientRejecting(new SnapshotHttpError(503, 'overloaded'));
        await expect(getPatientContext({ client, token: TOKEN, siteId: SITE, pid: PID })).rejects.toBeInstanceOf(
            SnapshotHttpError,
        );
    });

    it('fails closed when the snapshot endpoint is unreachable', async () => {
        const { client } = mockClientRejecting(new SnapshotNetworkError('unreachable'));
        await expect(getPatientContext({ client, token: TOKEN, siteId: SITE, pid: PID })).rejects.toBeInstanceOf(
            SnapshotNetworkError,
        );
    });

    it('fails closed when allergies are absent from the response (verifier-level safety rule)', async () => {
        // Architecture: "Fails closed if allergy data cannot be verified".
        // An empty allergies array from a successful endpoint call is *not*
        // automatically a failure (a patient may genuinely have no allergies),
        // but a missing key is — the snapshot contract requires the field.
        const { client } = mockClientResolving({ ...baseSnapshot, allergies: undefined });
        await expect(getPatientContext({ client, token: TOKEN, siteId: SITE, pid: PID })).rejects.toThrow();
    });

    it('returns an empty allergies array as a real result (NKDA case)', async () => {
        const { client } = mockClientResolving({ ...baseSnapshot, allergies: [] });
        const out = await getPatientContext({ client, token: TOKEN, siteId: SITE, pid: PID });
        expect(out.allergies).toEqual([]);
    });
});
