import { describe, expect, it } from 'vitest';

import { checkVendorHealth, SUITE_VENDOR_DEPENDENCIES, VENDORS } from './vendor-health-check.js';

const okResponse = (status = 200): Response =>
    new Response(JSON.stringify({ ok: true }), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = (responses: Record<string, Response | Error>): typeof fetch => {
    const f: typeof fetch = (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const resp = responses[url];
        if (resp === undefined) {
            return Promise.reject(new Error(`unexpected fetch: ${url}`));
        }
        if (resp instanceof Error) {
            return Promise.reject(resp);
        }
        return Promise.resolve(resp);
    };
    return f;
};

describe('checkVendorHealth', () => {
    it('every vendor 2xx → all ok, degradedVendors empty', async () => {
        const result = await checkVendorHealth({
            fetchImpl: fakeFetch({
                'https://status.anthropic.com/api/v2/status.json': okResponse(),
                'https://status.openai.com/api/v2/status.json': okResponse(),
                'https://status.cohere.com/api/v2/status.json': okResponse(),
                'https://status.pinecone.io/api/v2/status.json': okResponse(),
                'https://status.smith.langchain.com/api/v2/status.json': okResponse(),
            }),
        });
        expect(result.reports).toHaveLength(VENDORS.length);
        expect(result.degradedVendors).toEqual([]);
        for (const r of result.reports) {
            expect(r.status).toBe('ok');
            expect(r.httpStatus).toBe(200);
        }
    });

    it('non-2xx response marks vendor as degraded', async () => {
        const result = await checkVendorHealth({
            fetchImpl: fakeFetch({
                'https://status.anthropic.com/api/v2/status.json': okResponse(),
                'https://status.openai.com/api/v2/status.json': new Response('', { status: 503 }),
                'https://status.cohere.com/api/v2/status.json': okResponse(),
                'https://status.pinecone.io/api/v2/status.json': okResponse(),
                'https://status.smith.langchain.com/api/v2/status.json': okResponse(),
            }),
        });
        expect(result.degradedVendors).toEqual(['openai']);
        const openai = result.reports.find((r) => r.vendor === 'openai');
        expect(openai?.status).toBe('degraded');
        expect(openai?.httpStatus).toBe(503);
        expect(openai?.reason).toMatch(/non-2xx/);
    });

    it('thrown fetch error (DNS, network) marks vendor as degraded', async () => {
        const result = await checkVendorHealth({
            fetchImpl: fakeFetch({
                'https://status.anthropic.com/api/v2/status.json': okResponse(),
                'https://status.openai.com/api/v2/status.json': okResponse(),
                'https://status.cohere.com/api/v2/status.json': new Error('getaddrinfo ENOTFOUND'),
                'https://status.pinecone.io/api/v2/status.json': okResponse(),
                'https://status.smith.langchain.com/api/v2/status.json': okResponse(),
            }),
        });
        expect(result.degradedVendors).toEqual(['cohere']);
        const cohere = result.reports.find((r) => r.vendor === 'cohere');
        expect(cohere?.status).toBe('degraded');
        expect(cohere?.httpStatus).toBeNull();
        expect(cohere?.reason).toContain('ENOTFOUND');
    });

    it('endpoint overrides are respected (used in tests + edge cases)', async () => {
        const result = await checkVendorHealth({
            endpoints: { anthropic: 'https://anthropic.test/status' },
            fetchImpl: fakeFetch({
                'https://anthropic.test/status': okResponse(),
                'https://status.openai.com/api/v2/status.json': okResponse(),
                'https://status.cohere.com/api/v2/status.json': okResponse(),
                'https://status.pinecone.io/api/v2/status.json': okResponse(),
                'https://status.smith.langchain.com/api/v2/status.json': okResponse(),
            }),
        });
        expect(result.degradedVendors).toEqual([]);
    });

    it('checkedAt is an ISO 8601 timestamp', async () => {
        const result = await checkVendorHealth({
            fetchImpl: fakeFetch({
                'https://status.anthropic.com/api/v2/status.json': okResponse(),
                'https://status.openai.com/api/v2/status.json': okResponse(),
                'https://status.cohere.com/api/v2/status.json': okResponse(),
                'https://status.pinecone.io/api/v2/status.json': okResponse(),
                'https://status.smith.langchain.com/api/v2/status.json': okResponse(),
            }),
        });
        expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
    });
});

describe('SUITE_VENDOR_DEPENDENCIES', () => {
    it('every dependency entry references a known vendor', () => {
        const known = new Set<string>(VENDORS);
        const offenders: string[] = [];
        for (const [suite, deps] of Object.entries(SUITE_VENDOR_DEPENDENCIES)) {
            for (const v of deps) {
                if (!known.has(v)) {
                    offenders.push(`${suite}::${v}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('covers each of the four eval suites', () => {
        expect(new Set(Object.keys(SUITE_VENDOR_DEPENDENCIES))).toEqual(
            new Set(['briefing-graph', 'conversational-graph', 'document-extraction', 'end-to-end']),
        );
    });
});
