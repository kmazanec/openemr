import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getChartDocuments } from '../../src/tools/getChartDocuments.js';
import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const BASE = 'http://openemr';

const sampleResponse = {
    documents: [
        {
            document_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            doc_type: 'intake_form',
            canonical_ext: 'pdf',
        },
        {
            document_uuid: '11111111-2222-3333-4444-555555555555',
            doc_type: 'lab_pdf',
            canonical_ext: 'png',
        },
    ],
};

describe('getChartDocuments (chart-side document discovery)', () => {
    it('GETs chart-documents.php with site + pid and decodes the response', async () => {
        const { client, get } = mockAgentHttpResolving(sampleResponse);

        const result = await getChartDocuments({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/chart-documents.php?site=${SITE}&pid=${String(PID)}`,
        );
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.documents).toHaveLength(2);
            expect(result.documents[0]!.documentUuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
            expect(result.documents[0]!.docType).toBe('intake_form');
            expect(result.documents[0]!.canonicalExt).toBe('pdf');
            expect(result.documents[1]!.docType).toBe('lab_pdf');
        }
    });

    it('threads conversationId through as a query param when present', async () => {
        const { client, get } = mockAgentHttpResolving({ documents: [] });
        await getChartDocuments({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            openEmrBaseUrl: BASE,
            conversationId: 'conv-123',
        });
        const call = get.mock.calls[0]?.[0] as { url: string };
        expect(call.url).toContain('conversation=conv-123');
    });

    it('returns an empty `ok` result when the endpoint returns no documents', async () => {
        const { client } = mockAgentHttpResolving({ documents: [] });
        const result = await getChartDocuments({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.documents).toEqual([]);
        }
    });

    it('returns an explicit gap when the endpoint returns 5xx (fail-open)', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));
        const result = await getChartDocuments({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });
        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
        }
    });

    it('returns an explicit gap when the endpoint is unreachable (fail-open)', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));
        const result = await getChartDocuments({
            client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE,
        });
        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unreachable');
        }
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        // Misconfigured trust boundary, not a data gap — surfacing
        // this as a gap would hide a real failure.
        const { client } = mockAgentHttpRejecting(new AgentHttpError(403, ''));
        await expect(
            getChartDocuments({ client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('rejects an unknown doc_type at decode time (caller bug, not a fail-open)', async () => {
        const { client } = mockAgentHttpResolving({
            documents: [
                {
                    document_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                    doc_type: 'discharge_summary',
                    canonical_ext: 'pdf',
                },
            ],
        });
        await expect(
            getChartDocuments({ client, token: TOKEN, siteId: SITE, pid: PID, openEmrBaseUrl: BASE }),
        ).rejects.toThrow(/expected "lab_pdf", "intake_form", or "referral_letter"/);
    });

    it('throws on invalid pid (programmer error)', async () => {
        const { client } = mockAgentHttpResolving({ documents: [] });
        await expect(
            getChartDocuments({ client, token: TOKEN, siteId: SITE, pid: 0, openEmrBaseUrl: BASE }),
        ).rejects.toThrow(/positive integer/);
    });
});
