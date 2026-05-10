import { describe, expect, it, vi } from 'vitest';

import { createDocumentEvidenceRetriever } from '../../../src/graph/nodes/documentEvidenceRetriever.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type { BriefingSnapshot, DocumentEvidenceArgs, RequestEnvelope } from '../../../src/graph/types.js';
import type {
    ExtractionArtifact,
    SearchArtifactsFilters,
} from '../../../src/state/extractionArtifacts.js';

const PID = 42;

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'follow_up',
    question: 'What did her recent A1c lab show?',
};

const sourceRef = (id: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field },
    quote: id,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: sourceRef('42', 'patient.name'),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
};

const baseState = (overrides: Partial<BriefingState> = {}): BriefingState => ({
    envelope,
    priorTurnContext: { turns: [] },
    snapshot,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 1,
    retrieveChartArgs: null,
    documentEvidenceArgs: null,
    documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,
    evidenceRetrieverArgs: null,
    evidenceRetrieverOutput: null,
    supervisorIterations: 1,
    supervisorDecisionHistory: [],
    capHit: false, kickoffExtractionResults: [],
    ...overrides,
});

const labArtifact = (overrides: Partial<ExtractionArtifact> = {}): ExtractionArtifact => ({
    artifactId: '11111111-1111-1111-1111-111111111111',
    documentUuid: '22222222-2222-2222-2222-222222222222',
    pid: PID,
    docType: 'lab_pdf',
    extractorVersion: 'v1.0.0',
    schemaJson: {
        results: [
            {
                analyte: 'HbA1c',
                value: 6.4,
                page: 1,
                bbox: [40, 200, 380, 220],
                quote: 'HbA1c 6.4 %',
                confidence: 0.93,
            },
            {
                analyte: 'Glucose',
                value: 102,
                page: 1,
                bbox: [40, 240, 380, 260],
                quote: 'Glucose 102 mg/dL',
                confidence: 0.91,
            },
        ],
    },
    deltasJson: null,
    confidenceSignal: { patient_match_score: 1.0 },
    status: 'pending_confirmation',
    documentHash: 'a'.repeat(64),
    createdAt: '2026-05-04T12:00:00.000Z',
    confirmedAt: null,
    confirmedByUser: null,
    ...overrides,
});

const args = (overrides: Partial<DocumentEvidenceArgs> = {}): DocumentEvidenceArgs => ({
    query: 'HbA1c',
    lookback_days: 90,
    top_k: 5,
    ...overrides,
});

describe('createDocumentEvidenceRetriever (§C.1)', () => {
    it('queries searchArtifacts scoped to envelope.pid and the args lookback_days', async () => {
        const captured: SearchArtifactsFilters[] = [];
        const node = createDocumentEvidenceRetriever({
            store: {
                searchArtifacts: (filters) => {
                    captured.push(filters);
                    return Promise.resolve([]);
                },
            },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });

        await node(baseState({ documentEvidenceArgs: args({ lookback_days: 30 }) }));

        expect(captured.length).toBe(1);
        expect(captured[0]?.pid).toBe(PID);
        // 30-day lookback from 2026-05-05 → 2026-04-05.
        expect(captured[0]?.since.toISOString()).toBe('2026-04-05T00:00:00.000Z');
        // doc_types omitted in args → omitted in the filter (search the full status set).
        expect(captured[0]?.docTypes).toBeUndefined();
    });

    it('passes args.doc_types straight through to the store filter', async () => {
        const captured: SearchArtifactsFilters[] = [];
        const node = createDocumentEvidenceRetriever({
            store: {
                searchArtifacts: (filters) => {
                    captured.push(filters);
                    return Promise.resolve([]);
                },
            },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });

        await node(
            baseState({
                documentEvidenceArgs: args({ doc_types: ['lab_pdf'] }),
            }),
        );

        expect(captured[0]?.docTypes).toEqual(['lab_pdf']);
    });

    it('throws when the supervisor routes to it without populating documentEvidenceArgs', async () => {
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: () => Promise.resolve([]) },
        });
        await expect(node(baseState({ documentEvidenceArgs: null }))).rejects.toThrow(
            /documentEvidenceArgs/,
        );
    });

    it('projects each fact-shaped leaf into a snippet with bbox/page/quote and the artifact metadata', async () => {
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: () => Promise.resolve([labArtifact()]) },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });

        const out = await node(baseState({ documentEvidenceArgs: args({ top_k: 5 }) }));
        const snippets = out.documentEvidenceSnippets ?? [];
        expect(snippets.length).toBe(2);
        const a1c = snippets.find((s) => s.fieldPath.includes('0'));
        expect(a1c?.artifactId).toBe('11111111-1111-1111-1111-111111111111');
        expect(a1c?.documentUuid).toBe('22222222-2222-2222-2222-222222222222');
        expect(a1c?.docType).toBe('lab_pdf');
        expect(a1c?.page).toBe(1);
        expect(a1c?.bbox).toEqual([40, 200, 380, 220]);
        expect(a1c?.quote).toContain('HbA1c');
        expect(a1c?.confidence).toBe(0.93);
        expect(a1c?.extractorVersion).toBe('v1.0.0');
        expect(a1c?.createdAt).toBe('2026-05-04T12:00:00.000Z');
    });

    it('respects top_k by ranking keyword-relevant + recent snippets first', async () => {
        // Two artifacts: an older one whose quote matches "HbA1c", and a
        // brand-new one whose quote does not. With a top_k of 1 the
        // keyword + recency sum must surface the matching snippet, since
        // the keyword bonus (1.0) outweighs a recency-only edge.
        const matching = labArtifact({
            artifactId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            createdAt: '2026-04-15T00:00:00.000Z',
            schemaJson: {
                results: [
                    {
                        analyte: 'HbA1c',
                        value: 6.4,
                        page: 1,
                        bbox: [10, 10, 100, 30],
                        quote: 'HbA1c 6.4 %',
                    },
                ],
            },
        });
        const irrelevant = labArtifact({
            artifactId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            createdAt: '2026-05-04T00:00:00.000Z',
            schemaJson: {
                results: [
                    {
                        analyte: 'TSH',
                        value: 2.1,
                        page: 1,
                        bbox: [10, 50, 100, 70],
                        quote: 'TSH 2.1 mIU/L',
                    },
                ],
            },
        });
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: () => Promise.resolve([irrelevant, matching]) },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });

        const out = await node(
            baseState({ documentEvidenceArgs: args({ query: 'HbA1c', top_k: 1 }) }),
        );
        const snippets = out.documentEvidenceSnippets ?? [];
        expect(snippets.length).toBe(1);
        expect(snippets[0]?.artifactId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('returns the empty array (not null) when the store has no matching artifacts', async () => {
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: () => Promise.resolve([]) },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });
        const out = await node(baseState({ documentEvidenceArgs: args() }));
        expect(out.documentEvidenceSnippets).toEqual([]);
    });

    it('drops fact-shaped leaves missing one of the locator fields (schema-drift defense)', async () => {
        const drifted = labArtifact({
            schemaJson: {
                results: [
                    // Has a `quote` and `page` but no `bbox` — schema drift.
                    {
                        analyte: 'HbA1c',
                        value: 6.4,
                        page: 1,
                        quote: 'HbA1c 6.4 %',
                    },
                    // Fully-shaped fact — surfaces normally.
                    {
                        analyte: 'Glucose',
                        value: 102,
                        page: 1,
                        bbox: [10, 50, 100, 70],
                        quote: 'Glucose 102 mg/dL',
                    },
                ],
            },
        });
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: () => Promise.resolve([drifted]) },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });
        const out = await node(baseState({ documentEvidenceArgs: args({ top_k: 5 }) }));
        const snippets = out.documentEvidenceSnippets ?? [];
        expect(snippets.length).toBe(1);
        expect(snippets[0]?.quote).toContain('Glucose');
    });

    it('honors top_k: 1 even when many matching facts exist', async () => {
        const big = labArtifact({
            schemaJson: {
                results: Array.from({ length: 10 }, (_, i) => ({
                    analyte: `Analyte${i}`,
                    value: i,
                    page: 1,
                    bbox: [0, i * 20, 100, i * 20 + 10],
                    quote: `Analyte${i} reading`,
                })),
            },
        });
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: () => Promise.resolve([big]) },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });
        const out = await node(
            baseState({ documentEvidenceArgs: args({ query: 'reading', top_k: 1 }) }),
        );
        expect((out.documentEvidenceSnippets ?? []).length).toBe(1);
    });

    it('forwards the searchArtifacts call exactly once per invocation', async () => {
        const search = vi.fn().mockResolvedValue([]);
        const node = createDocumentEvidenceRetriever({
            store: { searchArtifacts: search },
            now: () => new Date('2026-05-05T00:00:00.000Z'),
        });
        await node(baseState({ documentEvidenceArgs: args() }));
        expect(search).toHaveBeenCalledTimes(1);
    });
});
