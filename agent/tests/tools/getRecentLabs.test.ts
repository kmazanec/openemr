import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getRecentLabs } from '../../src/tools/getRecentLabs.js';
import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';

const narrowResponse = {
    labs: [
        {
            analyte: 'A1c',
            value: '8.4',
            unit: '%',
            referenceRange: '<7.0',
            abnormalFlag: 'H',
            observedAt: '2026-04-15',
            source: { source_type: 'chart' as const, source_id: 'lab-1', locator: { field: 'observation.value' }, quote: 'lab-1' },
        },
    ],
};

describe('getRecentLabs (narrow conversational tool)', () => {
    it('GETs the labs endpoint with site + pid', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const result = await getRecentLabs({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/labs.php?site=${SITE}&pid=${String(PID)}`,
        );
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.labs).toHaveLength(1);
            expect(result.labs[0]!.analyte).toBe('A1c');
        }
    });

    it('returns an explicit gap when the endpoint returns 5xx', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));

        const result = await getRecentLabs({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/labs.*not available/i);
        }
    });

    it('returns an explicit gap when the endpoint is unreachable', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));

        const result = await getRecentLabs({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        // 401/403 indicates a misconfigured token, not a transient data
        // problem. Surfacing it as a gap would hide a real failure.
        const { client } = mockAgentHttpRejecting(new AgentHttpError(401, ''));
        await expect(
            getRecentLabs({ client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('returns an empty list as a real result, not a gap', async () => {
        const { client } = mockAgentHttpResolving({ labs: [] });

        const result = await getRecentLabs({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.labs).toEqual([]);
        }
    });
});
