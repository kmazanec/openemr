import type { Pinecone, Index, RecordMetadata } from '@pinecone-database/pinecone';

import { bm25Sparse, tokenize, type BM25Stats } from './bm25.js';

/**
 * Narrow embeddings seam — just the one method `evidenceRetriever`
 * calls. Typing it locally (instead of `Pick<OpenAI, 'embeddings'>`)
 * lets tests stub with a plain object; the OpenAI SDK's full
 * `Embeddings` class has private fields that fight `Pick`.
 */
export interface EmbeddingsClient {
    create(input: {
        readonly model: string;
        readonly input: string;
        readonly dimensions: number;
    }): Promise<{ readonly data: readonly { readonly embedding: number[] }[] }>;
}

/**
 * §C.3 Pinecone hybrid retriever — the "20 candidates before rerank"
 * layer of `evidenceRetriever`. Wraps the Pinecone SDK + the OpenAI
 * embeddings client so the graph node can ask for "top-N hybrid hits
 * for this query string" without knowing about either vendor.
 *
 * The shape mirrors `W2_ARCHITECTURE.md` §"evidenceRetriever" — dense
 * embedding via `text-embedding-3-large`, sparse BM25 vector over the
 * same corpus stats the reindex script wrote, hybrid fusion done by
 * Pinecone, top-20 returned. Metadata filtering on `publication` is
 * exposed because the supervisor's `source_filter` arg passes through
 * to it.
 *
 * Outage policy: a thrown error from the Pinecone client surfaces as a
 * `PineconeUnavailableError`, which the C.3 node converts to a `Gap`
 * on the retriever output. We don't retry inside the retriever — the
 * supervisor sees the gap, logs it, and routes around (per the
 * "Pinecone outage" row in §"Failure Modes").
 */

export const PINECONE_HYBRID_TOP_K = 20;
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIM = 3072;

/**
 * Raw Pinecone hybrid hit projected onto the fields the C.3 node and
 * the C.5 verifier care about. Drops the dense vector (we never need
 * to read it back) and pins the metadata shape the reindex script
 * upserts (see `agent/scripts/reindex-corpus.ts`).
 */
export interface PineconeHybridHit {
    readonly id: string;
    readonly score: number;
    readonly publication: string;
    readonly year: number;
    readonly section: string;
    readonly section_label: string;
    readonly title: string;
    readonly url: string;
    readonly license_tier: string;
    readonly chunk_text: string;
}

export interface PineconeQueryOptions {
    readonly query: string;
    readonly topK?: number;
    /**
     * Optional metadata filter. Passed straight through to Pinecone's
     * `$in` operator on the `publication` field.
     */
    readonly publicationFilter?: readonly string[];
}

export interface PineconeRetriever {
    /** True when the corpus stats at boot were empty (no chunks). */
    readonly isEmpty: boolean;
    query(opts: PineconeQueryOptions): Promise<readonly PineconeHybridHit[]>;
}

/**
 * Thrown when the Pinecone SDK call fails. The node catches this and
 * converts it to a `Gap` on the retriever output.
 */
export class PineconeUnavailableError extends Error {
    constructor(message: string, options?: { cause: unknown }) {
        super(message, options);
        this.name = 'PineconeUnavailableError';
    }
}

export interface PineconeRetrieverDeps {
    readonly pinecone: Pinecone;
    readonly indexName: string;
    readonly namespace: string;
    readonly embeddings: EmbeddingsClient;
    /**
     * Corpus BM25 stats fitted at boot from the same chunk bodies the
     * reindex script upserted. Query-side and index-side weights only
     * line up when they share the same stats — see `bm25.ts`.
     */
    readonly bm25Stats: BM25Stats;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';

const readStringMeta = (
    meta: RecordMetadata | undefined,
    key: string,
    fallback = '',
): string => {
    if (!isRecord(meta)) return fallback;
    const v = meta[key];
    return typeof v === 'string' ? v : fallback;
};

const readNumberMeta = (
    meta: RecordMetadata | undefined,
    key: string,
    fallback = 0,
): number => {
    if (!isRecord(meta)) return fallback;
    const v = meta[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

export const createPineconeRetriever = (
    deps: PineconeRetrieverDeps,
): PineconeRetriever => {
    const index: Index = deps.pinecone.index(deps.indexName);
    const namespaced = index.namespace(deps.namespace);
    const isEmpty = deps.bm25Stats.docCount === 0;

    return {
        isEmpty,
        query: async (opts: PineconeQueryOptions): Promise<readonly PineconeHybridHit[]> => {
            const topK = opts.topK ?? PINECONE_HYBRID_TOP_K;
            const tokens = tokenize(opts.query);
            const sparseValues = bm25Sparse(tokens, deps.bm25Stats);

            let denseValues: number[];
            try {
                const res = await deps.embeddings.create({
                    model: EMBEDDING_MODEL,
                    input: opts.query,
                    dimensions: EMBEDDING_DIM,
                });
                const first = res.data[0];
                if (first === undefined) {
                    throw new Error('OpenAI embeddings returned no data');
                }
                denseValues = first.embedding;
            } catch (err) {
                throw new PineconeUnavailableError(
                    'evidenceRetriever: query embedding failed',
                    { cause: err },
                );
            }

            const filter = opts.publicationFilter !== undefined && opts.publicationFilter.length > 0
                ? { publication: { $in: [...opts.publicationFilter] } }
                : undefined;

            let response;
            try {
                response = await namespaced.query({
                    topK,
                    vector: denseValues,
                    sparseVector: sparseValues,
                    includeMetadata: true,
                    ...(filter !== undefined ? { filter } : {}),
                });
            } catch (err) {
                throw new PineconeUnavailableError(
                    'evidenceRetriever: Pinecone query failed',
                    { cause: err },
                );
            }

            const matches = response.matches ?? [];
            return matches.map((m): PineconeHybridHit => ({
                id: m.id,
                score: m.score ?? 0,
                publication: readStringMeta(m.metadata, 'publication'),
                year: readNumberMeta(m.metadata, 'year'),
                section: readStringMeta(m.metadata, 'section'),
                section_label: readStringMeta(m.metadata, 'section_label'),
                title: readStringMeta(m.metadata, 'title'),
                url: readStringMeta(m.metadata, 'url'),
                license_tier: readStringMeta(m.metadata, 'license_tier'),
                chunk_text: readStringMeta(m.metadata, 'chunk_text'),
            }));
        },
    };
};
