import { describe, expect, it } from 'vitest';

import {
    CanonicalDocumentFallbackError,
    CanonicalDocumentFallbackNetworkError,
    CanonicalDocumentFallbackNotFound,
    createCanonicalDocumentFallbackClient,
} from '../../src/storage/canonicalDocumentFallback.js';

const BASE = 'http://openemr';
const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const buildFetch = (
    response: { status: number; bytes?: Buffer; bodyText?: string },
    capture?: { url?: string; headers?: Record<string, unknown> },
): typeof fetch => {
    const fn: typeof fetch = ((url: string, init?: RequestInit) => {
        if (capture !== undefined) {
            capture.url = url;
            capture.headers = (init?.headers as Record<string, unknown> | undefined) ?? {};
        }
        const status = response.status;
        const body = response.bytes ?? Buffer.from(response.bodyText ?? '');
        return Promise.resolve({
            status,
            ok: status >= 200 && status < 300,
            arrayBuffer: () =>
                Promise.resolve(
                    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
                ),
            text: () => Promise.resolve(body.toString('utf8')),
        } as unknown as Response);
    }) as unknown as typeof fetch;
    return fn;
};

describe('canonicalDocumentFallback client', () => {
    it('GETs document-bytes.php with site, pid, uuid query params and Bearer auth', async () => {
        const capture: { url?: string; headers?: Record<string, unknown> } = {};
        const bytes = Buffer.from('document-bytes');
        const fetchImpl = buildFetch({ status: 200, bytes }, capture);
        const client = createCanonicalDocumentFallbackClient({ baseUrl: BASE, fetchImpl });

        const out = await client.readBytes({
            documentUuid: UUID,
            pid: PID,
            token: TOKEN,
            siteId: SITE,
        });

        expect(out).toEqual(bytes);
        expect(capture.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/document-bytes.php?site=${SITE}&pid=${String(PID)}&uuid=${UUID}`,
        );
        expect(capture.headers?.['authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('threads conversationId through as a query param when present', async () => {
        const capture: { url?: string; headers?: Record<string, unknown> } = {};
        const fetchImpl = buildFetch({ status: 200, bytes: Buffer.from('x') }, capture);
        const client = createCanonicalDocumentFallbackClient({ baseUrl: BASE, fetchImpl });
        await client.readBytes({
            documentUuid: UUID,
            pid: PID,
            token: TOKEN,
            siteId: SITE,
            conversationId: 'conv-123',
        });
        expect(capture.url).toContain('conversation=conv-123');
    });

    it('throws CanonicalDocumentFallbackNotFound on 404 (document missing or out-of-scope)', async () => {
        const fetchImpl = buildFetch({ status: 404, bodyText: '{"error":"not_found"}' });
        const client = createCanonicalDocumentFallbackClient({ baseUrl: BASE, fetchImpl });
        await expect(
            client.readBytes({ documentUuid: UUID, pid: PID, token: TOKEN, siteId: SITE }),
        ).rejects.toBeInstanceOf(CanonicalDocumentFallbackNotFound);
    });

    it('throws CanonicalDocumentFallbackError on a non-404 non-2xx status', async () => {
        const fetchImpl = buildFetch({ status: 503, bodyText: '{"error":"snapshot_unavailable"}' });
        const client = createCanonicalDocumentFallbackClient({ baseUrl: BASE, fetchImpl });
        await expect(
            client.readBytes({ documentUuid: UUID, pid: PID, token: TOKEN, siteId: SITE }),
        ).rejects.toBeInstanceOf(CanonicalDocumentFallbackError);
    });

    it('throws CanonicalDocumentFallbackNetworkError when fetch itself rejects', async () => {
        const fetchImpl = ((): Promise<Response> =>
            Promise.reject(new TypeError('network'))) as typeof fetch;
        const client = createCanonicalDocumentFallbackClient({
            baseUrl: BASE,
            fetchImpl,
        });
        await expect(
            client.readBytes({ documentUuid: UUID, pid: PID, token: TOKEN, siteId: SITE }),
        ).rejects.toBeInstanceOf(CanonicalDocumentFallbackNetworkError);
    });

    it('throws synchronously on invalid input (programmer error, not data error)', async () => {
        const client = createCanonicalDocumentFallbackClient({
            baseUrl: BASE,
            fetchImpl: buildFetch({ status: 200, bytes: Buffer.from('') }),
        });
        await expect(
            client.readBytes({ documentUuid: UUID, pid: 0, token: TOKEN, siteId: SITE }),
        ).rejects.toThrow(/positive integer/);
        await expect(
            client.readBytes({ documentUuid: UUID, pid: PID, token: TOKEN, siteId: '' }),
        ).rejects.toThrow(/siteId/);
        await expect(
            client.readBytes({ documentUuid: '', pid: PID, token: TOKEN, siteId: SITE }),
        ).rejects.toThrow(/documentUuid/);
    });
});
