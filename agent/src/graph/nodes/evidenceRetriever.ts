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
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type {
    EvidenceArgs,
    EvidenceRetrieverOutput,
    EvidenceSnippet,
} from '../types.js';

/**
 * §C.3 `evidenceRetriever` node — replaces the A.7 stub.
 *
 * The supervisor narrows its structured-output args into
 * `state.evidenceRetrieverArgs` (a typed {@link EvidenceArgs}); this
 * node reads the slot, runs Pinecone hybrid retrieval (top-20) over
 * the `guidelines-v1` namespace, reranks via Cohere `rerank-v3.5` to
 * `args.top_k` (default 5), and writes the result to
 * `state.evidenceRetrieverOutput`.
 *
 * Failure modes per `W2_ARCHITECTURE.md` §"Failure Modes":
 *  - **Pinecone outage** → output carries a `Gap`, `snippets` is
 *    empty. The supervisor sees the gap on its next iteration and
 *    routes around the retriever.
 *  - **Cohere outage** → degraded mode. The Pinecone hybrid order is
 *    used as the rerank order (top-`k` by hybrid score), each snippet
 *    is tagged `degradedRerank: true`, and a `degraded-mode` trace
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

export const createEvidenceRetriever = (
    deps: EvidenceRetrieverDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        const startedAt = Date.now();
        const { args, topK } = resolveArgs(state);
        const queryHash = hashIdForTrace(args.query, tagSalt());

        // Phase 1 — Pinecone hybrid. A retriever-level error becomes a
        // gap on the output; the supervisor's next iteration sees it.
        let hits: readonly PineconeHybridHit[];
        try {
            hits = await deps.pineconeRetriever.query({
                query: args.query,
                topK: PINECONE_HYBRID_TOP_K,
                ...(args.source_filter !== undefined ? { publicationFilter: args.source_filter } : {}),
            });
        } catch (err) {
            if (err instanceof PineconeUnavailableError) {
                setRunMetadata({
                    tool: 'evidenceRetriever',
                    evidence_query_hash: queryHash,
                    evidence_event: 'pinecone-outage',
                    evidence_returned_count: 0,
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

        if (hits.length === 0) {
            // Empty Pinecone result is a legitimate "no matching chunk"
            // signal — distinct from an outage. Emit an empty snippet
            // list with no gap so the supervisor can choose to widen
            // the query or route to synthesize.
            setRunMetadata({
                tool: 'evidenceRetriever',
                evidence_query_hash: queryHash,
                evidence_top_k: topK,
                evidence_source_filter: args.source_filter ?? null,
                evidence_pinecone_count: 0,
                evidence_returned_count: 0,
                evidence_degraded_rerank: false,
                latency_ms: Date.now() - startedAt,
            });
            return { evidenceRetrieverOutput: { snippets: [], gap: null } };
        }

        // Phase 2 — Cohere rerank. A null return is the degraded-mode
        // signal; on degraded mode we use Pinecone's hybrid order as
        // the rerank order and tag each snippet so the synthesizer's
        // trace surface shows the path that ran.
        const rerankInput = hits.map((h) => h.chunk_text);
        const reranked = await deps.cohereRerank.rerank({
            query: args.query,
            documents: rerankInput,
            topN: topK,
        });

        let snippets: readonly EvidenceSnippet[];
        let degraded: boolean;
        if (reranked === null) {
            degraded = true;
            snippets = hits.slice(0, topK).map((hit) => projectHit(hit, hit.score, true));
            logger.warn(
                { queryHash, pineconeCount: hits.length },
                'evidenceRetriever: Cohere unavailable — degraded mode (Pinecone hybrid order)',
            );
        } else {
            degraded = false;
            // Trust Cohere's ordering. flatMap silently drops out-of-bound
            // indices so a malformed response can't read undefined hits.
            snippets = reranked.flatMap((r) => {
                const hit = hits[r.index];
                return hit === undefined ? [] : [projectHit(hit, r.relevanceScore, false)];
            });
        }

        setRunMetadata({
            tool: 'evidenceRetriever',
            evidence_query_hash: queryHash,
            evidence_top_k: topK,
            evidence_source_filter: args.source_filter ?? null,
            evidence_pinecone_count: hits.length,
            evidence_pinecone_chunk_ids: hits.map((h) => h.id),
            evidence_returned_chunk_ids: snippets.map((s) => s.chunkId),
            evidence_returned_count: snippets.length,
            evidence_degraded_rerank: degraded,
            ...(degraded ? { evidence_event: 'degraded-mode' } : {}),
            latency_ms: Date.now() - startedAt,
        });

        return { evidenceRetrieverOutput: { snippets, gap: null } };
    };
    return traceable(impl, { name: 'evidenceRetriever', run_type: 'chain' });
};
