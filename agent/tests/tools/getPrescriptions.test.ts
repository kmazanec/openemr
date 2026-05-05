import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getPrescriptions } from '../../src/tools/getPrescriptions.js';
import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';

const narrowResponse = {
    prescriptions: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            source: { source_type: 'chart' as const, source_id: 'rx-1', locator: { field: 'medication.name' }, quote: 'rx-1' },
        },
    ],
};

describe('getPrescriptions (narrow conversational tool)', () => {
    it('GETs the prescriptions endpoint with site + pid', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const out = await getPrescriptions({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string; token: string };
        expect(call.token).toBe(TOKEN);
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/prescriptions.php?site=${SITE}&pid=${String(PID)}`,
        );
        expect(out).toHaveLength(1);
        expect(out[0]!.name).toBe('Metformin');
    });

    it('fails closed on HTTP error', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));
        await expect(
            getPrescriptions({ client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('fails closed on network error', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));
        await expect(
            getPrescriptions({ client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE }),
        ).rejects.toBeInstanceOf(AgentNetworkError);
    });
});
