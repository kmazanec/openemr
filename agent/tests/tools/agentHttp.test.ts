import { describe, expect, it, vi } from 'vitest';

import {
    AgentHttpError,
    AgentNetworkError,
    createAgentHttpClient,
} from '../../src/tools/agentHttp.js';

const URL = 'http://example/test';
const TOKEN = 'tok';

const buildResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('agentHttp client', () => {
    it('returns the parsed JSON body on a 2xx response', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(buildResponse({ ok: true }));
        const client = createAgentHttpClient({ fetchImpl });

        const out = await client.get({ url: URL, token: TOKEN });

        expect(out).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const call = fetchImpl.mock.calls[0]!;
        expect(call[0]).toBe(URL);
        const init = call[1]!;
        expect(init.method).toBe('GET');
        expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('throws AgentHttpError on a 4xx and does NOT retry', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(buildResponse({}, 401));
        const client = createAgentHttpClient({ fetchImpl, retryDelayMs: 0 });

        await expect(client.get({ url: URL, token: TOKEN })).rejects.toBeInstanceOf(AgentHttpError);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries once on 5xx and surfaces the second failure', async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(buildResponse({}, 503))
            .mockResolvedValueOnce(buildResponse({}, 503));
        const client = createAgentHttpClient({ fetchImpl, retryDelayMs: 0 });

        await expect(client.get({ url: URL, token: TOKEN })).rejects.toBeInstanceOf(AgentHttpError);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('retries once on a fetch network error and succeeds the second time', async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(buildResponse({ ok: true }));
        const client = createAgentHttpClient({ fetchImpl, retryDelayMs: 0 });

        const out = await client.get({ url: URL, token: TOKEN });

        expect(out).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('throws AgentNetworkError after retry exhaustion', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
        const client = createAgentHttpClient({ fetchImpl, retryDelayMs: 0 });

        await expect(client.get({ url: URL, token: TOKEN })).rejects.toBeInstanceOf(AgentNetworkError);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
