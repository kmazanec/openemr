import { describe, expect, it, vi } from 'vitest';

import { createCohereRerankClient } from '../../src/retrievers/cohere.js';

const okResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });

interface Captured {
    readonly url: string;
    readonly body: string;
    readonly headers: Record<string, string>;
}

describe('createCohereRerankClient (§C.3)', () => {
    it('posts query + documents + top_n and returns parsed results', async () => {
        const captured: Captured[] = [];
        const fetchStub: typeof globalThis.fetch = (url, init) => {
            const urlStr = typeof url === 'string'
                ? url
                : url instanceof URL ? url.toString() : url.url;
            captured.push({
                url: urlStr,
                body: typeof init?.body === 'string' ? init.body : '',
                headers: { ...(init?.headers as Record<string, string>) },
            });
            return Promise.resolve(
                okResponse({
                    results: [
                        { index: 2, relevance_score: 0.95 },
                        { index: 0, relevance_score: 0.42 },
                    ],
                }),
            );
        };
        const client = createCohereRerankClient({
            apiKey: 'test-key',
            fetch: fetchStub,
        });

        const out = await client.rerank({
            query: 'colorectal cancer screening',
            documents: ['doc-a', 'doc-b', 'doc-c'],
            topN: 2,
        });

        expect(out).toEqual([
            { index: 2, relevanceScore: 0.95 },
            { index: 0, relevanceScore: 0.42 },
        ]);
        expect(captured[0]?.url).toBe('https://api.cohere.com/v2/rerank');
        const body = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>;
        expect(body['query']).toBe('colorectal cancer screening');
        expect(body['documents']).toEqual(['doc-a', 'doc-b', 'doc-c']);
        expect(body['top_n']).toBe(2);
        expect(captured[0]?.headers['Authorization']).toBe('Bearer test-key');
    });

    it('returns null on a 503 (degraded-mode fall-through)', async () => {
        const fetchStub: typeof globalThis.fetch = () =>
            Promise.resolve(new Response('upstream', { status: 503 }));
        const client = createCohereRerankClient({
            apiKey: 'test-key',
            fetch: fetchStub,
        });

        const out = await client.rerank({
            query: 'q',
            documents: ['a', 'b'],
            topN: 1,
        });

        expect(out).toBeNull();
    });

    it('returns null on a network error (degraded-mode fall-through)', async () => {
        const fetchStub: typeof globalThis.fetch = () =>
            Promise.reject(new Error('connection reset'));
        const client = createCohereRerankClient({
            apiKey: 'test-key',
            fetch: fetchStub,
        });

        const out = await client.rerank({
            query: 'q',
            documents: ['a', 'b'],
            topN: 1,
        });

        expect(out).toBeNull();
    });

    it('throws on a 401 — auth misconfiguration is a loud bug, not a degraded path', async () => {
        const fetchStub: typeof globalThis.fetch = () =>
            Promise.resolve(new Response('invalid api key', { status: 401 }));
        const client = createCohereRerankClient({
            apiKey: 'bad-key',
            fetch: fetchStub,
        });

        await expect(
            client.rerank({ query: 'q', documents: ['a'], topN: 1 }),
        ).rejects.toThrow(/401/);
    });

    it('throws on a malformed 200 response (Cohere returned an unexpected shape)', async () => {
        const fetchStub: typeof globalThis.fetch = () =>
            Promise.resolve(okResponse({ unexpected: 'shape' }));
        const client = createCohereRerankClient({
            apiKey: 'test-key',
            fetch: fetchStub,
        });

        await expect(
            client.rerank({ query: 'q', documents: ['a'], topN: 1 }),
        ).rejects.toThrow(/malformed/);
    });

    it('aborts the request after timeoutMs and returns null', async () => {
        // The retriever passes its AbortSignal via `init.signal` — wait
        // for it to abort and surface the error so the client can fall
        // through to the degraded path.
        const fetchStub = vi.fn((_url: unknown, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'));
                });
            });
        });
        const client = createCohereRerankClient({
            apiKey: 'test-key',
            fetch: fetchStub,
            timeoutMs: 20,
        });

        const out = await client.rerank({
            query: 'q',
            documents: ['a', 'b'],
            topN: 1,
        });

        expect(out).toBeNull();
    });
});
