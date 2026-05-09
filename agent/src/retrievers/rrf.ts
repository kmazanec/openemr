import type { PineconeHybridHit } from './pinecone.js';

/**
 * Reciprocal Rank Fusion over per-query Pinecone hybrid results.
 *
 * When the query rewriter expands one user-shaped query into N variants,
 * each variant runs against Pinecone independently and returns its own
 * top-K hybrid hits. RRF fuses the per-query rankings into one ordered
 * candidate list before rerank.
 *
 * RRF beats raw-score fusion across queries because:
 *  - Pinecone hybrid scores are not calibrated across queries — a 0.81
 *    on query A is not necessarily "more relevant" than a 0.62 on
 *    query B; the magnitudes depend on the query embedding's proximity
 *    to the corpus, which varies.
 *  - RRF only uses ranks (1, 2, 3, …), so the cross-query comparison
 *    is well-defined regardless of how the underlying retrievers
 *    score.
 *  - The k-smoothing constant (default 60, from Cormack et al. 2009)
 *    prevents the fusion from being dominated by the top-1 of any
 *    single query — chunks that appear in multiple queries' middles
 *    can outrank a single query's #1.
 *
 * After fusion the caller deduplicates by `chunk.id` (already done
 * here) and passes the top-M to Cohere rerank with the *original* user
 * query — see `evidenceRetriever.ts` for the wiring rationale. Capping
 * the fused output at 100 keeps a single Cohere call inside the
 * one-billed-search-unit boundary.
 *
 * Reference: Cormack, Clarke, Büttcher, "Reciprocal rank fusion
 * outperforms Condorcet and individual rank learning methods", SIGIR
 * 2009.
 */

/** Default smoothing constant from the original RRF paper. */
export const RRF_K = 60;

/**
 * Cap on the number of fused candidates returned. Sized so a downstream
 * single Cohere rerank call stays at one billed search unit
 * (Cohere bills 1 query × ≤100 docs as one unit). The retriever passes
 * `topM` explicitly; this constant is the documented default.
 */
export const RRF_DEFAULT_TOP_M = 100;

export interface RRFInput {
    /**
     * Per-query top-K results, in retrieval order (rank 1 first). The
     * outer array's order is informational; RRF is symmetric across
     * queries.
     */
    readonly perQueryHits: readonly (readonly PineconeHybridHit[])[];
    /** Cap on the fused output. Defaults to {@link RRF_DEFAULT_TOP_M}. */
    readonly topM?: number;
    /** RRF smoothing constant. Defaults to {@link RRF_K}. */
    readonly k?: number;
}

export interface FusedHit {
    /** The deduplicated hit. The first occurrence (by query order) wins for the document body. */
    readonly hit: PineconeHybridHit;
    /** Sum of `1 / (k + rank)` across queries that returned this chunk. */
    readonly rrfScore: number;
    /** Number of queries that returned this chunk. Useful for trace metadata. */
    readonly queryCoverage: number;
}

/**
 * Fuse N per-query Pinecone result lists into a single ranked list.
 * Stable sort: ties on `rrfScore` keep the first-seen ordering so the
 * function is deterministic regardless of `Array.sort` engine choice.
 */
export const fuseReciprocalRank = (input: RRFInput): readonly FusedHit[] => {
    const k = input.k ?? RRF_K;
    const topM = input.topM ?? RRF_DEFAULT_TOP_M;

    const aggregated = new Map<
        string,
        { hit: PineconeHybridHit; rrfScore: number; queryCoverage: number; firstSeenOrder: number }
    >();

    let firstSeenCounter = 0;
    for (const hits of input.perQueryHits) {
        for (let rank = 0; rank < hits.length; rank++) {
            const hit = hits[rank];
            if (hit === undefined) continue;
            const contribution = 1 / (k + rank + 1);
            const existing = aggregated.get(hit.id);
            if (existing === undefined) {
                aggregated.set(hit.id, {
                    hit,
                    rrfScore: contribution,
                    queryCoverage: 1,
                    firstSeenOrder: firstSeenCounter++,
                });
            } else {
                existing.rrfScore += contribution;
                existing.queryCoverage += 1;
            }
        }
    }

    const fused = [...aggregated.values()];
    fused.sort((a, b) => {
        if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
        return a.firstSeenOrder - b.firstSeenOrder;
    });

    return fused.slice(0, topM).map(({ hit, rrfScore, queryCoverage }) => ({
        hit,
        rrfScore,
        queryCoverage,
    }));
};
