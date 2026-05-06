import { describe, expect, it, vi } from 'vitest';

import { createEvidenceRetriever } from '../../../src/graph/nodes/evidenceRetriever.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type {
    BriefingSnapshot,
    EvidenceArgs,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import type { CohereRerankClient } from '../../../src/retrievers/cohere.js';
import {
    PineconeUnavailableError,
    type PineconeHybridHit,
    type PineconeRetriever,
    type PineconeQueryOptions,
} from '../../../src/retrievers/pinecone.js';

const PID = 42;

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'follow_up',
    question: 'When should colorectal cancer screening start?',
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

const args = (overrides: Partial<EvidenceArgs> = {}): EvidenceArgs => ({
    query: 'colorectal cancer screening',
    top_k: 3,
    ...overrides,
});

const sampleHits: readonly PineconeHybridHit[] = [
    {
        id: 'uspstf::colorectal-cancer-screening--recommendation-summary',
        score: 0.81,
        publication: 'USPSTF',
        year: 2021,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Colorectal Cancer: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends screening for colorectal cancer in all adults aged 45 to 75 years. (B recommendation)',
    },
    {
        id: 'uspstf::abdominal-aortic-aneurysm-screening--recommendation-summary',
        score: 0.72,
        publication: 'USPSTF',
        year: 2019,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Abdominal Aortic Aneurysm: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/abdominal-aortic-aneurysm-screening',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends one-time screening for abdominal aortic aneurysm with ultrasonography in men aged 65 to 75 who have ever smoked.',
    },
    {
        id: 'uspstf::lipid-screening--recommendation-summary',
        score: 0.65,
        publication: 'USPSTF',
        year: 2016,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Lipid Disorders in Adults: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lipid-disorders-adults',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends offering or referring adults with cardiovascular disease risk to behavioral counseling.',
    },
];

const buildPineconeRetriever = (
    queryFn: (opts: PineconeQueryOptions) => Promise<readonly PineconeHybridHit[]>,
    isEmpty = false,
): PineconeRetriever & { calls: PineconeQueryOptions[] } => {
    const calls: PineconeQueryOptions[] = [];
    return {
        isEmpty,
        calls,
        query: (opts) => {
            calls.push(opts);
            return queryFn(opts);
        },
    };
};

const buildCohereStub = (
    rerank: CohereRerankClient['rerank'],
): CohereRerankClient => ({ rerank });

describe('createEvidenceRetriever (§C.3)', () => {
    it('happy path: Pinecone top-N → Cohere rerank → top-k snippets with rerank scores', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve(sampleHits));
        const cohere = buildCohereStub(() =>
            Promise.resolve([
                { index: 0, relevanceScore: 0.97 },
                { index: 2, relevanceScore: 0.42 },
            ]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));

        const result = out.evidenceRetrieverOutput;
        expect(result).not.toBeNull();
        expect(result?.gap).toBeNull();
        expect(result?.snippets).toHaveLength(2);
        expect(result?.snippets[0]?.chunkId).toBe(
            'uspstf::colorectal-cancer-screening--recommendation-summary',
        );
        expect(result?.snippets[0]?.rerankScore).toBe(0.97);
        expect(result?.snippets[0]?.degradedRerank).toBe(false);
        expect(result?.snippets[0]?.publication).toBe('USPSTF');
        expect(result?.snippets[0]?.year).toBe(2021);
        expect(result?.snippets[0]?.title).toBe('Colorectal Cancer: Screening');
        expect(result?.snippets[0]?.section).toBe('recommendation-summary');
        expect(result?.snippets[0]?.licenseTier).toBe('public_domain');
        expect(result?.snippets[0]?.quote).toContain('45 to 75');
        // Re-ordered: index 2 (lipid) was second in rerank, not third.
        expect(result?.snippets[1]?.chunkId).toBe(
            'uspstf::lipid-screening--recommendation-summary',
        );
    });

    it('forwards source_filter to the Pinecone query', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve(sampleHits));
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.9 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        await node(
            baseState({
                evidenceRetrieverArgs: args({
                    source_filter: ['USPSTF'],
                    top_k: 1,
                }),
            }),
        );

        expect(pinecone.calls[0]?.publicationFilter).toEqual(['USPSTF']);
    });

    it('Cohere outage: falls through to top-k by Pinecone hybrid score, tagged degradedRerank', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve(sampleHits));
        // null is the contract for "Cohere is unavailable, use the
        // hybrid order instead" (per cohere.ts).
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));

        const result = out.evidenceRetrieverOutput;
        expect(result?.gap).toBeNull();
        expect(result?.snippets).toHaveLength(2);
        // Degraded mode: Pinecone hybrid order is preserved as-is — top
        // two hits in the order Pinecone returned them.
        expect(result?.snippets[0]?.chunkId).toBe(
            'uspstf::colorectal-cancer-screening--recommendation-summary',
        );
        expect(result?.snippets[0]?.rerankScore).toBe(0.81);
        expect(result?.snippets[0]?.degradedRerank).toBe(true);
        expect(result?.snippets[1]?.chunkId).toBe(
            'uspstf::abdominal-aortic-aneurysm-screening--recommendation-summary',
        );
        expect(result?.snippets[1]?.degradedRerank).toBe(true);
    });

    it('Pinecone outage: returns Gap{evidence-retrieval-unavailable} with empty snippets', async () => {
        const pinecone = buildPineconeRetriever(() =>
            Promise.reject(
                new PineconeUnavailableError('Pinecone unavailable: connection reset'),
            ),
        );
        // Cohere should not be called when Pinecone fails.
        const rerank = vi.fn(() => Promise.resolve(null));
        const cohere = buildCohereStub(rerank);
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args() }));

        const result = out.evidenceRetrieverOutput;
        expect(result?.snippets).toEqual([]);
        expect(result?.gap?.kind).toBe('gap');
        expect(result?.gap?.reason).toBe('evidence-retrieval-unavailable');
        expect(rerank).not.toHaveBeenCalled();
    });

    it('Pinecone returns no matches: emits empty snippets with no gap (legitimate "no match" signal)', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([]));
        const rerank = vi.fn(() => Promise.resolve(null));
        const cohere = buildCohereStub(rerank);
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args() }));

        const result = out.evidenceRetrieverOutput;
        expect(result?.snippets).toEqual([]);
        expect(result?.gap).toBeNull();
        // Skipping rerank when there's nothing to rerank avoids burning
        // a Cohere call on an empty list.
        expect(rerank).not.toHaveBeenCalled();
    });

    it('throws when the supervisor routes here without populating evidenceRetrieverArgs', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([]));
        const cohere = buildCohereStub(() => Promise.resolve([]));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        await expect(node(baseState({ evidenceRetrieverArgs: null }))).rejects.toThrow(
            /evidenceRetrieverArgs/,
        );
    });

    it('skips rerank entries that point at indices Pinecone did not return', async () => {
        const pinecone = buildPineconeRetriever(() =>
            Promise.resolve([sampleHits[0]!, sampleHits[1]!]),
        );
        // Cohere claims index 99 (which was never in the input). The
        // node must drop that result rather than read undefined.
        const cohere = buildCohereStub(() =>
            Promise.resolve([
                { index: 1, relevanceScore: 0.88 },
                { index: 99, relevanceScore: 0.5 },
            ]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));

        expect(out.evidenceRetrieverOutput?.snippets).toHaveLength(1);
        expect(out.evidenceRetrieverOutput?.snippets[0]?.chunkId).toBe(
            'uspstf::abdominal-aortic-aneurysm-screening--recommendation-summary',
        );
    });

    it('truncates long chunk bodies to a 600-char excerpt as the snippet quote', async () => {
        const longBody = 'A'.repeat(2000);
        const pinecone = buildPineconeRetriever(() =>
            Promise.resolve([
                {
                    ...sampleHits[0]!,
                    chunk_text: longBody,
                },
            ]),
        );
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.9 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 1 }) }));

        const quote = out.evidenceRetrieverOutput?.snippets[0]?.quote ?? '';
        expect(quote.length).toBe(600);
    });

    it('rethrows non-PineconeUnavailableError errors (so unexpected bugs surface loudly)', async () => {
        const pinecone = buildPineconeRetriever(() =>
            Promise.reject(new TypeError('boom')),
        );
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        await expect(node(baseState({ evidenceRetrieverArgs: args() }))).rejects.toBeInstanceOf(
            TypeError,
        );
    });
});
