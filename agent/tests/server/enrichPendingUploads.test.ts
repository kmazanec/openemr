import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { RequestEnvelope } from '../../src/graph/types.js';
import { enrichPendingUploadsWithChartDocuments } from '../../src/server/enrichPendingUploads.js';
import type { ExtractionArtifact, ExtractionArtifactStore } from '../../src/state/extractionArtifacts.js';
import { AgentHttpError, type AgentHttpClient } from '../../src/tools/agentHttp.js';

const SILENT = pino({ level: 'silent' });
const BASE = 'http://openemr';
const TOKEN = 'tok';

const baseEnvelope: RequestEnvelope = {
    conversationId: 'conv-1',
    requestId: 'req-1',
    siteId: 'default',
    actor: { userId: 'user-1' } as RequestEnvelope['actor'],
    patient: { pid: 42, uuid: '' },
    task: 'follow_up',
    question: 'what was in her intake form?',
};

const mockClient = (response: unknown): { client: AgentHttpClient; get: ReturnType<typeof vi.fn> } => {
    const get = vi.fn().mockResolvedValue(response);
    return { client: { get: get as AgentHttpClient['get'] }, get };
};

const rejectingClient = (err: unknown): AgentHttpClient => ({
    get: vi.fn().mockRejectedValue(err) as AgentHttpClient['get'],
});

const buildStore = (artifacts: readonly Pick<ExtractionArtifact, 'documentUuid'>[] = []): ExtractionArtifactStore => {
    // Only `searchArtifacts` is exercised by the helper; the rest are
    // typed-no-op stubs so the cast satisfies the interface.
    const search = vi.fn().mockResolvedValue(artifacts);
    return {
        searchArtifacts: search,
        claimDocumentLock: vi.fn(),
        findArtifactByDocumentHash: vi.fn(),
        findArtifactById: vi.fn(),
        insertArtifact: vi.fn(),
        updateArtifactStatus: vi.fn(),
        recordDisposition: vi.fn(),
        getDispositions: vi.fn(),
    };
};

describe('enrichPendingUploadsWithChartDocuments', () => {
    it('splices unprocessed chart docs onto pendingUploads, tagged chart-enriched with filename', async () => {
        const { client } = mockClient({
            documents: [
                {
                    document_uuid: 'doc-A',
                    doc_type: 'intake_form',
                    canonical_ext: 'pdf',
                    filename: 'intake-2026-01-12.pdf',
                },
                {
                    document_uuid: 'doc-B',
                    doc_type: 'lab_pdf',
                    canonical_ext: 'pdf',
                    filename: 'cbc-2026-02-01.pdf',
                },
            ],
        });
        const out = await enrichPendingUploadsWithChartDocuments(
            { httpClient: client, extractionArtifactStore: buildStore(), openEmrBaseUrl: BASE, logger: SILENT },
            { envelope: baseEnvelope, token: TOKEN },
        );
        expect(out.pendingUploads).toHaveLength(2);
        expect(out.pendingUploads?.[0]?.documentUuid).toBe('doc-A');
        expect(out.pendingUploads?.[0]?.docType).toBe('intake_form');
        expect(out.pendingUploads?.[0]?.source).toBe('chart-enriched');
        expect(out.pendingUploads?.[0]?.filename).toBe('intake-2026-01-12.pdf');
        expect(out.pendingUploads?.[1]?.documentUuid).toBe('doc-B');
        expect(out.pendingUploads?.[1]?.source).toBe('chart-enriched');
        expect(out.pendingUploads?.[1]?.filename).toBe('cbc-2026-02-01.pdf');
    });

    it('drops chart docs that already have an extraction artifact', async () => {
        const { client } = mockClient({
            documents: [
                { document_uuid: 'already-extracted', doc_type: 'intake_form', canonical_ext: 'pdf' },
                { document_uuid: 'fresh', doc_type: 'lab_pdf', canonical_ext: 'pdf' },
            ],
        });
        const store = buildStore([{ documentUuid: 'already-extracted' }]);
        const out = await enrichPendingUploadsWithChartDocuments(
            { httpClient: client, extractionArtifactStore: store, openEmrBaseUrl: BASE, logger: SILENT },
            { envelope: baseEnvelope, token: TOKEN },
        );
        expect(out.pendingUploads).toHaveLength(1);
        expect(out.pendingUploads?.[0]?.documentUuid).toBe('fresh');
    });

    it('drops chart docs whose uuid is already in envelope.pendingUploads (chat-upload precedence)', async () => {
        const { client } = mockClient({
            documents: [
                { document_uuid: 'already-uploaded-via-chat', doc_type: 'intake_form', canonical_ext: 'pdf' },
                { document_uuid: 'chart-only', doc_type: 'lab_pdf', canonical_ext: 'pdf' },
            ],
        });
        const envelope: RequestEnvelope = {
            ...baseEnvelope,
            pendingUploads: [
                { documentUuid: 'already-uploaded-via-chat', docType: 'intake_form', canonicalExt: 'pdf' },
            ],
        };
        const out = await enrichPendingUploadsWithChartDocuments(
            { httpClient: client, extractionArtifactStore: buildStore(), openEmrBaseUrl: BASE, logger: SILENT },
            { envelope, token: TOKEN },
        );
        expect(out.pendingUploads).toHaveLength(2);
        // The chat-upload entry stays, chart-only gets appended, the
        // duplicate from the chart side is dropped.
        const uuids = out.pendingUploads?.map((u) => u.documentUuid) ?? [];
        expect(uuids).toEqual(['already-uploaded-via-chat', 'chart-only']);
    });

    it('returns the envelope unchanged when chart-documents endpoint 5xx (fail-open)', async () => {
        const client = rejectingClient(new AgentHttpError(503, ''));
        const out = await enrichPendingUploadsWithChartDocuments(
            { httpClient: client, extractionArtifactStore: buildStore(), openEmrBaseUrl: BASE, logger: SILENT },
            { envelope: baseEnvelope, token: TOKEN },
        );
        expect(out).toEqual(baseEnvelope);
    });

    it('rethrows on auth error (401/403) — that is a config bug, not a fail-open case', async () => {
        const client = rejectingClient(new AgentHttpError(401, ''));
        await expect(
            enrichPendingUploadsWithChartDocuments(
                { httpClient: client, extractionArtifactStore: buildStore(), openEmrBaseUrl: BASE, logger: SILENT },
                { envelope: baseEnvelope, token: TOKEN },
            ),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('still surfaces chart docs when the artifact-store lookup fails (treat-as-unextracted fallback)', async () => {
        // Postgres outage on the artifact lookup must not silence
        // chart-doc discovery. Worst case the supervisor re-extracts
        // an already-extracted doc, which the pipeline's document
        // lock collapses to a no-op.
        const { client } = mockClient({
            documents: [
                { document_uuid: 'doc-A', doc_type: 'intake_form', canonical_ext: 'pdf' },
            ],
        });
        // Partial stub — the helper only consults `searchArtifacts`,
        // so leaving the other methods off keeps the test focused on
        // the failure path under exercise.
        const store = {
            searchArtifacts: vi.fn().mockRejectedValue(new Error('pg down')),
        } as unknown as ExtractionArtifactStore;
        const out = await enrichPendingUploadsWithChartDocuments(
            { httpClient: client, extractionArtifactStore: store, openEmrBaseUrl: BASE, logger: SILENT },
            { envelope: baseEnvelope, token: TOKEN },
        );
        expect(out.pendingUploads).toHaveLength(1);
        expect(out.pendingUploads?.[0]?.documentUuid).toBe('doc-A');
    });

    it('returns the envelope unchanged when the chart has no Clinical-Copilot-categorized documents', async () => {
        const { client } = mockClient({ documents: [] });
        const out = await enrichPendingUploadsWithChartDocuments(
            { httpClient: client, extractionArtifactStore: buildStore(), openEmrBaseUrl: BASE, logger: SILENT },
            { envelope: baseEnvelope, token: TOKEN },
        );
        expect(out).toBe(baseEnvelope);
    });
});
