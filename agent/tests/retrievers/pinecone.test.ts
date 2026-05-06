import { describe, expect, it, vi } from 'vitest';
import type { Pinecone, RecordMetadata } from '@pinecone-database/pinecone';

import { computeBM25Stats, tokenize } from '../../src/retrievers/bm25.js';
import {
    PineconeUnavailableError,
    createPineconeRetriever,
    type EmbeddingsClient,
} from '../../src/retrievers/pinecone.js';

const fakeStats = computeBM25Stats([
    tokenize('Colorectal cancer screening recommendation'),
    tokenize('Lipid panel cholesterol guidance'),
    tokenize('A1c diabetes screening adult'),
]);

const buildPineconeStub = (
    queryFn: (req: unknown) => Promise<unknown>,
): { stub: Pick<Pinecone, 'index'>; calls: unknown[] } => {
    const calls: unknown[] = [];
    const namespaced = {
        query: vi.fn((req: unknown) => {
            calls.push(req);
            return queryFn(req);
        }),
    };
    const index = {
        namespace: vi.fn(() => namespaced),
    };
    return {
        stub: {
            // The real Index type is large — cast through unknown for the
            // narrow surface we use (`namespace().query()`).
            index: vi.fn(() => index as unknown as ReturnType<Pinecone['index']>),
        },
        calls,
    };
};

const buildEmbeddingsStub = (
    vector: number[] = Array.from({ length: 3072 }, (_, i) => i / 3072),
): EmbeddingsClient & { inputs: string[] } => {
    const inputs: string[] = [];
    return {
        inputs,
        create: (req: { input: string }) => {
            inputs.push(req.input);
            return Promise.resolve({ data: [{ embedding: vector }] });
        },
    };
};

describe('createPineconeRetriever (§C.3)', () => {
    it('queries Pinecone with the dense + sparse vectors and projects the metadata', async () => {
        const sample: RecordMetadata = {
            publication: 'USPSTF',
            year: 2021,
            section: 'recommendation-summary',
            section_label: 'Recommendation Summary',
            title: 'Colorectal Cancer: Screening',
            url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening',
            license_tier: 'public_domain',
            chunk_text: 'The USPSTF recommends screening for colorectal cancer in adults aged 45 to 75.',
        };
        const { stub, calls } = buildPineconeStub(() =>
            Promise.resolve({
                matches: [
                    {
                        id: 'uspstf::colorectal-cancer-screening--recommendation-summary',
                        score: 0.91,
                        metadata: sample,
                    },
                ],
            }),
        );
        const embeddings = buildEmbeddingsStub();

        const retriever = createPineconeRetriever({
            pinecone: stub as unknown as Pinecone,
            indexName: 'agent-clinical-copilot',
            namespace: 'guidelines-v1',
            embeddings,
            bm25Stats: fakeStats,
        });
        const hits = await retriever.query({
            query: 'colorectal cancer screening',
        });

        expect(hits.length).toBe(1);
        expect(hits[0]?.id).toBe('uspstf::colorectal-cancer-screening--recommendation-summary');
        expect(hits[0]?.publication).toBe('USPSTF');
        expect(hits[0]?.year).toBe(2021);
        expect(hits[0]?.section).toBe('recommendation-summary');
        expect(hits[0]?.title).toBe('Colorectal Cancer: Screening');
        expect(hits[0]?.chunk_text).toContain('USPSTF recommends');
        // The query call carried both dense and sparse vectors.
        const req = calls[0] as {
            vector: number[];
            sparseVector: { indices: number[]; values: number[] };
            topK: number;
        };
        expect(req.vector.length).toBe(3072);
        expect(req.sparseVector.indices.length).toBeGreaterThan(0);
        expect(req.sparseVector.values.length).toBe(req.sparseVector.indices.length);
        expect(req.topK).toBe(20);
    });

    it('forwards a publication filter as a Pinecone $in clause', async () => {
        const { stub, calls } = buildPineconeStub(() => Promise.resolve({ matches: [] }));
        const retriever = createPineconeRetriever({
            pinecone: stub as unknown as Pinecone,
            indexName: 'idx',
            namespace: 'guidelines-v1',
            embeddings: buildEmbeddingsStub(),
            bm25Stats: fakeStats,
        });

        await retriever.query({
            query: 'colorectal screening',
            publicationFilter: ['USPSTF'],
        });

        const req = calls[0] as { filter?: { publication: { $in: string[] } } };
        expect(req.filter).toEqual({ publication: { $in: ['USPSTF'] } });
    });

    it('omits the filter clause when no publication filter is supplied', async () => {
        const { stub, calls } = buildPineconeStub(() => Promise.resolve({ matches: [] }));
        const retriever = createPineconeRetriever({
            pinecone: stub as unknown as Pinecone,
            indexName: 'idx',
            namespace: 'guidelines-v1',
            embeddings: buildEmbeddingsStub(),
            bm25Stats: fakeStats,
        });

        await retriever.query({ query: 'colorectal screening' });

        const req = calls[0] as { filter?: unknown };
        expect(req.filter).toBeUndefined();
    });

    it('honors a topK override', async () => {
        const { stub, calls } = buildPineconeStub(() => Promise.resolve({ matches: [] }));
        const retriever = createPineconeRetriever({
            pinecone: stub as unknown as Pinecone,
            indexName: 'idx',
            namespace: 'guidelines-v1',
            embeddings: buildEmbeddingsStub(),
            bm25Stats: fakeStats,
        });

        await retriever.query({ query: 'A1c targets', topK: 5 });

        const req = calls[0] as { topK: number };
        expect(req.topK).toBe(5);
    });

    it('wraps Pinecone client errors as PineconeUnavailableError', async () => {
        const { stub } = buildPineconeStub(() =>
            Promise.reject(new Error('connection reset')),
        );
        const retriever = createPineconeRetriever({
            pinecone: stub as unknown as Pinecone,
            indexName: 'idx',
            namespace: 'guidelines-v1',
            embeddings: buildEmbeddingsStub(),
            bm25Stats: fakeStats,
        });

        await expect(
            retriever.query({ query: 'colorectal screening' }),
        ).rejects.toBeInstanceOf(PineconeUnavailableError);
    });

    it('wraps OpenAI embedding errors as PineconeUnavailableError (gap-on-failure path)', async () => {
        const { stub } = buildPineconeStub(() => Promise.resolve({ matches: [] }));
        const retriever = createPineconeRetriever({
            pinecone: stub as unknown as Pinecone,
            indexName: 'idx',
            namespace: 'guidelines-v1',
            embeddings: {
                create: () => Promise.reject(new Error('rate-limit')),
            },
            bm25Stats: fakeStats,
        });

        // The OpenAI side counts as part of "the retrieval pipeline can't run"
        // — the node converts both into the same Gap so the supervisor sees
        // one observable failure mode.
        await expect(
            retriever.query({ query: 'colorectal screening' }),
        ).rejects.toBeInstanceOf(PineconeUnavailableError);
    });

    it('isEmpty reports true when the BM25 stats have no documents', () => {
        const retriever = createPineconeRetriever({
            pinecone: buildPineconeStub(() => Promise.resolve({ matches: [] })).stub as unknown as Pinecone,
            indexName: 'idx',
            namespace: 'guidelines-v1',
            embeddings: buildEmbeddingsStub(),
            bm25Stats: computeBM25Stats([]),
        });
        expect(retriever.isEmpty).toBe(true);
    });
});
