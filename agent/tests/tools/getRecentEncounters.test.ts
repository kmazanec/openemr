import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getRecentEncounters } from '../../src/tools/getRecentEncounters.js';
import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';

const narrowResponse = {
    encounters: [
        {
            encounterDate: '2026-03-01',
            type: 'Office Visit',
            reason: 'Diabetes follow-up',
            source: { source_type: 'chart' as const, source_id: 'enc-1', locator: { field: 'encounter.date' }, quote: 'enc-1' },
        },
    ],
};

describe('getRecentEncounters (narrow conversational tool)', () => {
    it('GETs the encounters endpoint with site + pid', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const result = await getRecentEncounters({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/encounters.php?site=${SITE}&pid=${String(PID)}`,
        );
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.encounters).toHaveLength(1);
            expect(result.encounters[0]!.type).toBe('Office Visit');
        }
    });

    it('returns an explicit gap on 5xx', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));

        const result = await getRecentEncounters({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/encounters.*not available/i);
        }
    });

    it('returns an explicit gap on network error', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));

        const result = await getRecentEncounters({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(403, ''));
        await expect(
            getRecentEncounters({
                client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
            }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });
});
