/**
 * §B.7 Tests for the OpenEMR Tier-1 RPC client. Mirrors the
 * `snapshotClient.test.ts` style: stub `fetch`, drive happy-path,
 * transient retry, and error-class branches.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    DocumentReferenceHttpError,
    DocumentReferenceMalformedResponseError,
    DocumentReferenceNetworkError,
    createOpenEmrDocumentReferenceClient,
} from '../../src/storage/openemrDocumentReferenceClient.js';

const okResponse = (uuid: string): Response =>
    new Response(JSON.stringify({ document_uuid: uuid }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

describe('openemrDocumentReferenceClient', () => {
    it('happy path returns canonical document_uuid', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('aaaa-bbbb'));
        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
        });

        const result = await client.writeDocumentReference({
            pid: 4242,
            docType: 'lab_pdf',
            spacesUrl: 's3://bucket/4242/uuid.pdf',
            mimeType: 'application/pdf',
            filename: 'a.pdf',
            token: 'JWT',
            siteId: 'default',
        });

        expect(result.documentUuid).toBe('aaaa-bbbb');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const call = fetchImpl.mock.calls[0]!;
        expect(call[0]).toBe(
            'https://emr.example.test/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/document_reference.php?site=default',
        );
        const init = call[1] as RequestInit;
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toEqual({
            pid: 4242,
            doc_type: 'lab_pdf',
            spaces_url: 's3://bucket/4242/uuid.pdf',
            mime_type: 'application/pdf',
            filename: 'a.pdf',
        });
    });

    it('retries once on transient 5xx then succeeds', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('boom', { status: 503 }))
            .mockResolvedValueOnce(okResponse('aaaa-bbbb'));

        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
            retryDelayMs: 0,
        });

        const result = await client.writeDocumentReference({
            pid: 1,
            docType: 'intake_form',
            spacesUrl: 's3://b/1/x.pdf',
            mimeType: 'application/pdf',
            filename: 'x.pdf',
            token: 'JWT',
            siteId: 'default',
        });

        expect(result.documentUuid).toBe('aaaa-bbbb');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('throws DocumentReferenceHttpError on 4xx (no retry)', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(new Response('{"error":"scope_not_permitted"}', { status: 403 }));
        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
            retryDelayMs: 0,
        });

        await expect(
            client.writeDocumentReference({
                pid: 1,
                docType: 'lab_pdf',
                spacesUrl: 's3://b/1/x.pdf',
                mimeType: 'application/pdf',
                filename: 'x.pdf',
                token: 'JWT',
                siteId: 'default',
            }),
        ).rejects.toBeInstanceOf(DocumentReferenceHttpError);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('throws DocumentReferenceNetworkError after retry exhausted', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
            retryDelayMs: 0,
        });

        await expect(
            client.writeDocumentReference({
                pid: 1,
                docType: 'lab_pdf',
                spacesUrl: 's3://b/1/x.pdf',
                mimeType: 'application/pdf',
                filename: 'x.pdf',
                token: 'JWT',
                siteId: 'default',
            }),
        ).rejects.toBeInstanceOf(DocumentReferenceNetworkError);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('throws DocumentReferenceMalformedResponseError when body is missing document_uuid', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(new Response('{"unrelated":"shape"}', { status: 200 }));
        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
            retryDelayMs: 0,
        });

        await expect(
            client.writeDocumentReference({
                pid: 1,
                docType: 'lab_pdf',
                spacesUrl: 's3://b/1/x.pdf',
                mimeType: 'application/pdf',
                filename: 'x.pdf',
                token: 'JWT',
                siteId: 'default',
            }),
        ).rejects.toBeInstanceOf(DocumentReferenceMalformedResponseError);
    });

    it('rejects invalid pid before reaching fetch', async () => {
        const fetchImpl = vi.fn();
        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
        });
        await expect(
            client.writeDocumentReference({
                pid: 0,
                docType: 'lab_pdf',
                spacesUrl: 's3://b/1/x.pdf',
                mimeType: 'application/pdf',
                filename: 'x.pdf',
                token: 'JWT',
                siteId: 'default',
            }),
        ).rejects.toThrow('pid must be a positive integer');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('threads conversation id into the query string when present', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse('uuid-1'));
        const client = createOpenEmrDocumentReferenceClient({
            baseUrl: 'https://emr.example.test',
            fetchImpl,
        });
        await client.writeDocumentReference({
            pid: 1,
            docType: 'lab_pdf',
            spacesUrl: 's3://b/1/x.pdf',
            mimeType: 'application/pdf',
            filename: 'x.pdf',
            token: 'JWT',
            siteId: 'default',
            conversationId: 'conv-99',
        });
        const url = fetchImpl.mock.calls[0]![0] as string;
        expect(url).toContain('conversation=conv-99');
    });
});
