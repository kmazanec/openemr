import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getPatientContext } from '../../src/tools/getPatientContext.js';
import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';

const narrowResponse = {
    patient: {
        pid: PID,
        uuid: 'u',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        source: { system: 'openemr', recordType: 'Patient', recordId: '42' },
    },
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: { system: 'openemr', recordType: 'Condition', recordId: 'c-1' },
        },
    ],
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'Moderate',
            source: { system: 'openemr', recordType: 'AllergyIntolerance', recordId: 'a-1' },
        },
    ],
};

describe('getPatientContext (narrow conversational tool)', () => {
    it('GETs the patientContext endpoint with site + pid', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const out = await getPatientContext({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/patientContext.php?site=${SITE}&pid=${String(PID)}`,
        );
        expect(out.patient.displayName).toBe('Mrs. Patel');
        expect(out.diagnoses).toHaveLength(1);
        expect(out.allergies).toHaveLength(1);
    });

    it('fails closed when the endpoint returns an HTTP error', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, 'overloaded'));
        await expect(
            getPatientContext({
                client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
            }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('fails closed when the endpoint is unreachable', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));
        await expect(
            getPatientContext({
                client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
            }),
        ).rejects.toBeInstanceOf(AgentNetworkError);
    });

    it('fails closed when allergies are absent from the response', async () => {
        // Architecture: "Fails closed if allergy data cannot be verified".
        // An empty allergies array from a successful endpoint call is *not*
        // automatically a failure (a patient may genuinely have no allergies),
        // but a missing key is — the response contract requires the field.
        const { client } = mockAgentHttpResolving({ ...narrowResponse, allergies: undefined });
        await expect(
            getPatientContext({
                client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow();
    });

    it('returns an empty allergies array as a real result (NKDA case)', async () => {
        const { client } = mockAgentHttpResolving({ ...narrowResponse, allergies: [] });
        const out = await getPatientContext({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });
        expect(out.allergies).toEqual([]);
    });
});
