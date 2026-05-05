import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getVitalsHistory } from '../../src/tools/getVitalsHistory.js';

import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';
const VITAL_TYPE = 'systolic_bp' as const;
const LOOKBACK = 365;

const narrowResponse = {
    vitals: [
        {
            observedAt: '2025-04-15',
            bpSystolic: '148',
            bpDiastolic: '88',
            pulse: null,
            respiration: null,
            temperatureF: null,
            weightLbs: null,
            heightInches: null,
            bmi: null,
            oxygenSaturation: null,
            source: { source_type: 'chart' as const, source_id: 'vit-1', locator: { field: 'observation.value' }, quote: 'vit-1' },
        },
        {
            observedAt: '2026-04-15',
            bpSystolic: '138',
            bpDiastolic: '82',
            pulse: null,
            respiration: null,
            temperatureF: null,
            weightLbs: null,
            heightInches: null,
            bmi: null,
            oxygenSaturation: null,
            source: { source_type: 'chart' as const, source_id: 'vit-2', locator: { field: 'observation.value' }, quote: 'vit-2' },
        },
    ],
};

describe('getVitalsHistory (vitals trend tool)', () => {
    it('GETs the vitals-history endpoint with site, pid, vital_type, lookback_days', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const result = await getVitalsHistory({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            vitalType: VITAL_TYPE,
            lookbackDays: LOOKBACK,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        const url = new URL(call.url);
        expect(url.pathname).toBe(
            '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/vitals-history.php',
        );
        expect(url.searchParams.get('site')).toBe(SITE);
        expect(url.searchParams.get('pid')).toBe(String(PID));
        expect(url.searchParams.get('vital_type')).toBe(VITAL_TYPE);
        expect(url.searchParams.get('lookback_days')).toBe(String(LOOKBACK));

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.vitals).toHaveLength(2);
            expect(result.vitals[0]!.bpSystolic).toBe('148');
            expect(result.vitals[1]!.bpSystolic).toBe('138');
        }
    });

    it('returns an explicit gap when the endpoint returns 5xx', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));

        const result = await getVitalsHistory({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            vitalType: VITAL_TYPE,
            lookbackDays: LOOKBACK,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/vitals history.*not available/i);
        }
    });

    it('returns an explicit gap when the endpoint is unreachable', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));

        const result = await getVitalsHistory({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            vitalType: VITAL_TYPE,
            lookbackDays: LOOKBACK,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(401, ''));
        await expect(
            getVitalsHistory({
                client,
                token: TOKEN,
                siteId: SITE,
                pid: PID,
                vitalType: VITAL_TYPE,
                lookbackDays: LOOKBACK,
                openEmrBaseUrl: BASE,
            }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('throws on invalid vital type', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getVitalsHistory({
                client,
                token: TOKEN,
                siteId: SITE,
                pid: PID,
                // @ts-expect-error: deliberately invalid
                vitalType: 'not_a_real_vital',
                lookbackDays: LOOKBACK,
                openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/vitalType must be one of/);
    });

    it('throws on non-positive lookback', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getVitalsHistory({
                client,
                token: TOKEN,
                siteId: SITE,
                pid: PID,
                vitalType: VITAL_TYPE,
                lookbackDays: 0,
                openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/lookbackDays/);
    });

    it('throws on excessive lookback', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getVitalsHistory({
                client,
                token: TOKEN,
                siteId: SITE,
                pid: PID,
                vitalType: VITAL_TYPE,
                lookbackDays: 999_999,
                openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/lookbackDays/);
    });
});
