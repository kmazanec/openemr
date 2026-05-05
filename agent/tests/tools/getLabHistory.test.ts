import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getLabHistory } from '../../src/tools/getLabHistory.js';

import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';
const ANALYTE = 'Hemoglobin A1c';
const LOOKBACK = 730;

const narrowResponse = {
    labs: [
        {
            analyte: 'Hemoglobin A1c',
            value: '7.2',
            unit: '%',
            referenceRange: '4.0-5.6',
            abnormalFlag: 'H',
            observedAt: '2024-04-15',
            source: { source_type: 'chart' as const, source_id: 'lab-1', locator: { field: 'observation.value' }, quote: 'lab-1' },
        },
        {
            analyte: 'Hemoglobin A1c',
            value: '8.1',
            unit: '%',
            referenceRange: '4.0-5.6',
            abnormalFlag: 'H',
            observedAt: '2025-04-15',
            source: { source_type: 'chart' as const, source_id: 'lab-2', locator: { field: 'observation.value' }, quote: 'lab-2' },
        },
    ],
};

describe('getLabHistory (UC2 narrow tool)', () => {
    it('GETs the lab-history endpoint with site, pid, analyte, lookback_days', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const result = await getLabHistory({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            analyte: ANALYTE,
            lookbackDays: LOOKBACK,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        // URLSearchParams encodes the space as `+`; assert the parsed
        // query string rather than a brittle exact match.
        const url = new URL(call.url);
        expect(url.pathname).toBe('/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/lab-history.php');
        expect(url.searchParams.get('site')).toBe(SITE);
        expect(url.searchParams.get('pid')).toBe(String(PID));
        expect(url.searchParams.get('analyte')).toBe(ANALYTE);
        expect(url.searchParams.get('lookback_days')).toBe(String(LOOKBACK));

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.labs).toHaveLength(2);
            expect(result.labs[0]!.value).toBe('7.2');
            expect(result.labs[1]!.value).toBe('8.1');
        }
    });

    it('returns an explicit gap when the endpoint returns 5xx', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));

        const result = await getLabHistory({
            client, token: TOKEN, siteId: SITE, pid: PID,
            analyte: ANALYTE, lookbackDays: LOOKBACK, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/lab history.*not available/i);
        }
    });

    it('returns an explicit gap when the endpoint is unreachable', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));

        const result = await getLabHistory({
            client, token: TOKEN, siteId: SITE, pid: PID,
            analyte: ANALYTE, lookbackDays: LOOKBACK, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(401, ''));
        await expect(
            getLabHistory({
                client, token: TOKEN, siteId: SITE, pid: PID,
                analyte: ANALYTE, lookbackDays: LOOKBACK, openEmrBaseUrl: BASE,
            }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('returns an empty list as a real result, not a gap', async () => {
        const { client } = mockAgentHttpResolving({ labs: [] });

        const result = await getLabHistory({
            client, token: TOKEN, siteId: SITE, pid: PID,
            analyte: ANALYTE, lookbackDays: LOOKBACK, openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.labs).toEqual([]);
        }
    });

    it('throws on invalid input (empty analyte)', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getLabHistory({
                client, token: TOKEN, siteId: SITE, pid: PID,
                analyte: '', lookbackDays: LOOKBACK, openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/analyte is required/);
    });

    it('throws on invalid input (non-positive lookback)', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getLabHistory({
                client, token: TOKEN, siteId: SITE, pid: PID,
                analyte: ANALYTE, lookbackDays: 0, openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/lookbackDays/);
    });

    it('throws on invalid input (excessive lookback)', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getLabHistory({
                client, token: TOKEN, siteId: SITE, pid: PID,
                analyte: ANALYTE, lookbackDays: 999_999, openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/lookbackDays/);
    });
});
