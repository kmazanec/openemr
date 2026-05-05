import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getVitals } from '../../src/tools/getVitals.js';

import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';

const narrowResponse = {
    vitals: [
        {
            observedAt: '2026-04-15',
            bpSystolic: '142',
            bpDiastolic: '86',
            pulse: '78',
            respiration: '16',
            temperatureF: '98.6',
            weightLbs: '212.4',
            heightInches: '70.0',
            bmi: '30.5',
            oxygenSaturation: '98',
            source: { source_type: 'chart' as const, source_id: 'vit-1', locator: { field: 'observation.value' }, quote: 'vit-1' },
        },
    ],
};

describe('getVitals (narrow conversational tool)', () => {
    it('GETs the vitals endpoint with site + pid', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const result = await getVitals({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/vitals.php?site=${SITE}&pid=${String(PID)}`,
        );
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.vitals).toHaveLength(1);
            expect(result.vitals[0]!.bpSystolic).toBe('142');
            expect(result.vitals[0]!.weightLbs).toBe('212.4');
        }
    });

    it('returns an explicit gap when the endpoint returns 5xx', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));

        const result = await getVitals({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/vitals.*not available/i);
        }
    });

    it('returns an explicit gap when the endpoint is unreachable', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));

        const result = await getVitals({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(401, ''));
        await expect(
            getVitals({ client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('returns an empty list as a real result, not a gap', async () => {
        const { client } = mockAgentHttpResolving({ vitals: [] });

        const result = await getVitals({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.vitals).toEqual([]);
        }
    });
});
