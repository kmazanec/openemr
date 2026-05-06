/**
 * §C.3 BM25 helpers shared between the corpus reindex script and the
 * `evidenceRetriever` query path. Both sides must use the same
 * tokenization and the same Robertson BM25 weights so the sparse
 * vectors live in the same vocabulary space — query-side and
 * index-side weights only line up when they're computed the same way.
 *
 * The original C.2 plan called for `pinecone-text` for BM25; that
 * package is Python-only, so we ship the formula inline. Wire format
 * (`{indices, values}` alongside the dense vector) is identical to
 * what Pinecone hybrid expects.
 *
 * Token IDs use FNV-1a 32-bit hashing — stable across runs, low
 * collision rate at our vocabulary size.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const natural = require('natural') as {
    WordTokenizer: new () => { tokenize: (s: string) => string[] };
};

const tokenizer = new natural.WordTokenizer();

export function tokenize(text: string): string[] {
    return tokenizer
        .tokenize(text.toLowerCase())
        .filter((t) => t.length > 1 && t.length < 30)
        .map((t) => t.replace(/[^a-z0-9]/g, ''))
        .filter((t) => t.length > 0);
}

/** 32-bit FNV-1a hash of a token, used as the sparse-vector index. */
export function hashToken(token: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i += 1) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export interface SparseVector {
    readonly indices: number[];
    readonly values: number[];
}

export interface BM25Stats {
    readonly avgDocLength: number;
    readonly docCount: number;
    readonly docFreq: ReadonlyMap<string, number>;
}

export function computeBM25Stats(docs: readonly (readonly string[])[]): BM25Stats {
    const docCount = docs.length;
    let totalLen = 0;
    const docFreq = new Map<string, number>();
    for (const doc of docs) {
        totalLen += doc.length;
        const seen = new Set<string>();
        for (const t of doc) {
            if (seen.has(t)) continue;
            seen.add(t);
            docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        }
    }
    return {
        avgDocLength: docCount > 0 ? totalLen / docCount : 0,
        docCount,
        docFreq,
    };
}

/**
 * Build a Pinecone-shaped sparse vector for a token stream. `k1=1.2`
 * and `b=0.75` are the canonical BM25 defaults. Hash collisions keep
 * the larger weight (deterministic tie-break — collisions are rare
 * enough at our vocabulary size that the choice doesn't shift recall
 * meaningfully, but pinning it keeps tests stable).
 */
export function bm25Sparse(
    tokens: readonly string[],
    stats: BM25Stats,
): SparseVector {
    const k1 = 1.2;
    const b = 0.75;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const indicesMap = new Map<number, number>();
    for (const [term, freq] of tf) {
        const df = stats.docFreq.get(term) ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (stats.docCount - df + 0.5) / (df + 0.5));
        const norm = k1 * (1 - b + (b * tokens.length) / (stats.avgDocLength || 1));
        const weight = (idf * (freq * (k1 + 1))) / (freq + norm);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const id = hashToken(term);
        const existing = indicesMap.get(id);
        if (existing === undefined || weight > existing) {
            indicesMap.set(id, weight);
        }
    }

    const indices: number[] = [];
    const values: number[] = [];
    for (const [id, w] of indicesMap) {
        indices.push(id);
        values.push(w);
    }
    return { indices, values };
}
