import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import {
    hashIdForTrace,
    setRunMetadata,
    tagSalt,
} from '../../observability/traceMetadata.js';
import {
    PINECONE_HYBRID_TOP_K,
    PineconeUnavailableError,
    type PineconeHybridHit,
    type PineconeRetriever,
} from '../../retrievers/pinecone.js';
import type { CohereRerankClient } from '../../retrievers/cohere.js';
import {
    QueryRewriterUnavailableError,
    type QueryRewriter,
    type RewriteResult,
} from '../../retrievers/queryRewriter.js';
import { fuseReciprocalRank, RRF_DEFAULT_TOP_M } from '../../retrievers/rrf.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type {
    EvidenceArgs,
    EvidenceRetrieverOutput,
    EvidenceSnippet,
} from '../types.js';

/**
 * `evidenceRetriever` node — guideline RAG with multi-query rewriting.
 *
 * The supervisor narrows its structured-output args into
 * `state.evidenceRetrieverArgs` (a typed {@link EvidenceArgs}); this
 * node reads the slot, expands the original query into N rewritten
 * variants via {@link QueryRewriter}, runs Pinecone hybrid retrieval
 * (top-20) for each variant in parallel over the `guidelines-v1`
 * namespace, fuses the per-variant results with Reciprocal Rank
 * Fusion, then reranks the deduplicated top-M against the **original**
 * user query via Cohere `rerank-v3.5` to `args.top_k` (default 5), and
 * writes the result to `state.evidenceRetrieverOutput`.
 *
 * Why multi-query + RRF + single rerank with the original query:
 *  - Hybrid (BM25 + dense) retrieval already covers BM25 keyword vs.
 *    dense semantic complementarity. The remaining failure mode on a
 *    clinical-guideline corpus is *the user's phrasing not matching
 *    the publisher's phrasing* — "heart attack" vs "myocardial
 *    infarction", "high blood pressure" vs "hypertension", etc.
 *    Generating paraphrase, step-back, and terminology-shifted
 *    variants attacks that mismatch directly.
 *  - RRF fuses ranks (not raw scores) across the per-variant lists, so
 *    the cross-query comparison stays well-defined even though the
 *    Pinecone hybrid scores are not calibrated across queries.
 *  - Rerank runs *once* against the fused, deduplicated candidate
 *    list, with the **original** user query as the rerank query (not
 *    one of the rewrites). The rewrites' job is to widen recall in
 *    Pinecone; final ordering is the cross-encoder's call against the
 *    user's actual intent. This stays at one Cohere search unit
 *    (≤100 docs per call) for the same per-call cost as the single-
 *    query path.
 *
 * Failure modes per `W2_ARCHITECTURE.md` §"Failure Modes":
 *  - **Query rewriter outage** → degraded mode. Fall back to
 *    single-query retrieval (just the original query). Tagged
 *    `degradedRewrite: true` in trace metadata. Pinecone + Cohere
 *    proceed normally.
 *  - **Pinecone outage** → output carries a `Gap`, `snippets` is
 *    empty. The supervisor sees the gap on its next iteration and
 *    routes around the retriever. A failure on *any* of the parallel
 *    Pinecone calls (rewriter present or absent) escalates to a Gap —
 *    same fail-closed posture as the single-query path.
 *  - **Cohere outage** → degraded rerank. The fused RRF order is used
 *    as the rerank order (top-`k` by RRF score), each snippet is
 *    tagged `degradedRerank: true`, and a `degraded-mode` trace
 *    event fires. The synthesizer treats the snippets identically.
 *
 * Quote excerpt: the chunk body can run to a few KB (USPSTF
 * "Clinical Considerations" sections in particular). The synthesizer's
 * substring-match contract needs enough text to anchor a citation
 * even when the load-bearing recommendation language sits past the
 * opening paragraphs. We pin the quote at 1200 chars (roughly four
 * paragraphs of guideline text) — long enough to cover the
 * "Clinical Considerations" body in most USPSTF/CDC chunks, short
 * enough to keep the prompt body bounded. Eval cases assert the
 * substring match against this excerpt, not the full body.
 */

const logger = createLogger('graph:evidenceRetriever');

/** Quote excerpt length (chars). Short enough to keep prompts bounded; long enough to anchor a substring-match against load-bearing recommendation language deeper in the chunk. */
const QUOTE_EXCERPT_CHARS = 1200;

const DEFAULT_TOP_K = 5;

export interface EvidenceRetrieverDeps {
    readonly pineconeRetriever: PineconeRetriever;
    readonly cohereRerank: CohereRerankClient;
    /**
     * Optional query rewriter. When undefined, the retriever runs in
     * single-query mode (just the original query). Production wiring
     * supplies one; the per-MR Vitest gate's structural tests pass it
     * as a stub or omit it to assert the legacy single-query path.
     */
    readonly queryRewriter?: QueryRewriter;
}

const resolveArgs = (state: BriefingState): {
    readonly args: EvidenceArgs;
    readonly topK: number;
} => {
    const args = state.evidenceRetrieverArgs;
    if (args === null) {
        throw new Error(
            'evidenceRetriever: state.evidenceRetrieverArgs is null; supervisor must narrow before routing',
        );
    }
    return { args, topK: args.top_k ?? DEFAULT_TOP_K };
};

const excerpt = (text: string): string => {
    if (text.length <= QUOTE_EXCERPT_CHARS) return text;
    return text.slice(0, QUOTE_EXCERPT_CHARS).trimEnd();
};

const projectHit = (
    hit: PineconeHybridHit,
    rerankScore: number,
    degraded: boolean,
): EvidenceSnippet => ({
    chunkId: hit.id,
    publication: hit.publication,
    year: hit.year,
    section: hit.section,
    title: hit.title,
    ...(hit.url.length > 0 ? { url: hit.url } : {}),
    licenseTier: hit.license_tier,
    quote: excerpt(hit.chunk_text),
    rerankScore,
    degradedRerank: degraded,
});

/**
 * Try to expand the original query via the rewriter. On failure, fall
 * back to single-query mode (just the original query). The retriever
 * never escalates a rewriter outage to a Gap — the user's question
 * still works, just with the legacy recall posture.
 */
const expandQuery = async (
    rewriter: QueryRewriter | undefined,
    original: string,
): Promise<{ readonly result: RewriteResult; readonly degraded: boolean }> => {
    if (rewriter === undefined) {
        return {
            result: { original, variants: [], queries: [original] },
            degraded: false,
        };
    }
    try {
        const result = await rewriter.rewrite(original);
        return { result, degraded: false };
    } catch (err) {
        if (err instanceof QueryRewriterUnavailableError) {
            return {
                result: { original, variants: [], queries: [original] },
                degraded: true,
            };
        }
        throw err;
    }
};

export const createEvidenceRetriever = (
    deps: EvidenceRetrieverDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        const startedAt = Date.now();
        const { args, topK } = resolveArgs(state);
        const queryHash = hashIdForTrace(args.query, tagSalt());

        const { result: rewrite, degraded: degradedRewrite } = await expandQuery(
            deps.queryRewriter,
            args.query,
        );
        if (degradedRewrite) {
            logger.warn(
                { queryHash },
                'evidenceRetriever: query rewriter unavailable — falling back to single-query retrieval',
            );
        }

        // Phase 1 — Pinecone hybrid, fanned out across the rewritten
        // query set. Failure on *any* variant escalates to a Gap (same
        // fail-closed posture as the single-query path) — partial
        // recall on a guideline lookup is worse than a clean degraded
        // signal that the supervisor can route around.
        let perQueryHits: readonly (readonly PineconeHybridHit[])[];
        try {
            perQueryHits = await Promise.all(
                rewrite.queries.map((q) =>
                    deps.pineconeRetriever.query({
                        query: q,
                        topK: PINECONE_HYBRID_TOP_K,
                        ...(args.source_filter !== undefined
                            ? { publicationFilter: args.source_filter }
                            : {}),
                    }),
                ),
            );
        } catch (err) {
            if (err instanceof PineconeUnavailableError) {
                setRunMetadata({
                    tool: 'evidenceRetriever',
                    evidence_query_hash: queryHash,
                    evidence_event: 'pinecone-outage',
                    evidence_returned_count: 0,
                    evidence_query_variants: rewrite.queries.length,
                    evidence_degraded_rewrite: degradedRewrite,
                    latency_ms: Date.now() - startedAt,
                });
                logger.warn(
                    { queryHash, err: err.message },
                    'evidenceRetriever: Pinecone unavailable — emitting gap',
                );
                const output: EvidenceRetrieverOutput = {
                    snippets: [],
                    gap: {
                        kind: 'gap',
                        reason: 'evidence-retrieval-unavailable',
                        message: 'Guideline evidence is temporarily unavailable.',
                    },
                };
                return { evidenceRetrieverOutput: output };
            }
            throw err;
        }

        // Phase 2 — RRF-fuse the per-query lists. The original query is
        // queries[0], so the original-query hits are the first lane the
        // fuser sees; RRF ties resolve on first-seen, preserving the
        // single-query path's ordering when no variant adds a stronger
        // candidate.
        const fused = fuseReciprocalRank({
            perQueryHits,
            topM: RRF_DEFAULT_TOP_M,
        });

        const totalRawHits = perQueryHits.reduce((sum, hits) => sum + hits.length, 0);

        if (fused.length === 0) {
            // Empty Pinecone result is a legitimate "no matching chunk"
            // signal — distinct from an outage. Emit an empty snippet
            // list with no gap so the supervisor can choose to widen
            // the query or route to synthesize.
            setRunMetadata({
                tool: 'evidenceRetriever',
                evidence_query_hash: queryHash,
                evidence_top_k: topK,
                evidence_source_filter: args.source_filter ?? null,
                evidence_query_variants: rewrite.queries.length,
                evidence_query_variant_kinds: rewrite.variants.map((v) => v.kind),
                evidence_degraded_rewrite: degradedRewrite,
                evidence_pinecone_count: totalRawHits,
                evidence_fused_unique_count: 0,
                evidence_returned_count: 0,
                evidence_degraded_rerank: false,
                latency_ms: Date.now() - startedAt,
            });
            return { evidenceRetrieverOutput: { snippets: [], gap: null } };
        }

        // Phase 3 — Cohere rerank against the **original** user query.
        // The rewrites widened recall in Pinecone; the cross-encoder
        // makes the final ordering call against the user's actual
        // intent, not against a paraphrase. A null return is the
        // degraded-mode signal; on degraded mode we keep the RRF order
        // and tag each snippet so the trace surface shows the path
        // that ran.
        const fusedHits = fused.map((f) => f.hit);
        const rerankInput = fusedHits.map((h) => h.chunk_text);
        const reranked = await deps.cohereRerank.rerank({
            query: args.query,
            documents: rerankInput,
            topN: topK,
        });

        let snippets: readonly EvidenceSnippet[];
        let degradedRerank: boolean;
        if (reranked === null) {
            degradedRerank = true;
            // On degraded rerank, surface Pinecone's hybrid score for the
            // single-query path (preserves the legacy contract — eval
            // cases assert exact hybrid scores) and the RRF score when
            // multiple queries fed the fusion (no single hybrid score
            // makes sense across variants).
            const useHybridScore = rewrite.queries.length === 1;
            snippets = fusedHits
                .slice(0, topK)
                .map((hit, i) =>
                    projectHit(
                        hit,
                        useHybridScore ? hit.score : fused[i]!.rrfScore,
                        true,
                    ),
                );
            logger.warn(
                { queryHash, fusedCount: fused.length, useHybridScore },
                'evidenceRetriever: Cohere unavailable — degraded mode',
            );
        } else {
            degradedRerank = false;
            // Trust Cohere's ordering. flatMap silently drops out-of-bound
            // indices so a malformed response can't read undefined hits.
            snippets = reranked.flatMap((r) => {
                const hit = fusedHits[r.index];
                return hit === undefined ? [] : [projectHit(hit, r.relevanceScore, false)];
            });
        }

        setRunMetadata({
            tool: 'evidenceRetriever',
            evidence_query_hash: queryHash,
            evidence_top_k: topK,
            evidence_source_filter: args.source_filter ?? null,
            evidence_query_variants: rewrite.queries.length,
            evidence_query_variant_kinds: rewrite.variants.map((v) => v.kind),
            evidence_degraded_rewrite: degradedRewrite,
            evidence_pinecone_count: totalRawHits,
            evidence_fused_unique_count: fused.length,
            evidence_pinecone_chunk_ids: fusedHits.map((h) => h.id),
            evidence_returned_chunk_ids: snippets.map((s) => s.chunkId),
            evidence_returned_count: snippets.length,
            evidence_degraded_rerank: degradedRerank,
            ...(degradedRerank || degradedRewrite ? { evidence_event: 'degraded-mode' } : {}),
            latency_ms: Date.now() - startedAt,
        });

        return { evidenceRetrieverOutput: { snippets, gap: null } };
    };
    return traceable(impl, { name: 'evidenceRetriever', run_type: 'chain' });
};
