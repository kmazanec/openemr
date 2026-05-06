import { createLogger } from '../observability/logger.js';

/**
 * §C.3 Cohere rerank client. The supervisor's `evidenceRetriever`
 * calls Pinecone for top-20 hybrid hits, then this client reranks them
 * down to `top_k` using Cohere's cross-encoder. Per
 * `W2_ARCHITECTURE.md` §"evidenceRetriever" — rerank is the final
 * relevance-ordering layer; without it, the top of the synthesizer's
 * prompt body is dominated by surface-form term overlap rather than
 * semantic match.
 *
 * Direct REST against `https://api.cohere.com/v2/rerank` rather than
 * the `cohere-ai` SDK: one endpoint, ~30 lines of glue, no extra dep.
 *
 * Default model is `rerank-v3.5` (Cohere's current latest English
 * rerank model — supersedes the `rerank-english-v3.0` / "rerank-3"
 * generation referenced in some older docs). Override via the
 * `COHERE_RERANK_MODEL` env var without a code change.
 *
 * Degraded-mode contract per `W2_ARCHITECTURE.md` §"Failure Modes"
 * "Cohere outage" row: a 5xx, a network error, or an HTTP timeout
 * returns `null` to the caller, which then falls through to top-`k`
 * by Pinecone hybrid score and emits a `degraded-mode` trace event.
 * 4xx responses (auth/key issues, malformed payload) are configuration
 * bugs, not transient outages — they throw so the runner sees them
 * loudly during local development.
 */

const logger = createLogger('retrievers:cohere');

const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
export const DEFAULT_COHERE_RERANK_MODEL = 'rerank-v3.5';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CohereRerankInput {
    readonly query: string;
    readonly documents: readonly string[];
    readonly topN: number;
}

export interface CohereRerankResult {
    /**
     * Index into the input `documents` array. Surface-stable across
     * Cohere's response shapes — both v1 and v2 return zero-indexed
     * positions.
     */
    readonly index: number;
    /**
     * Relevance score in `[0, 1]`. Cohere doesn't pin a precise lower
     * bound across model versions, but `rerank-v3.5` returns probabilities.
     */
    readonly relevanceScore: number;
}

export interface CohereRerankClient {
    /**
     * Rerank `documents` against `query`. Returns `null` on transient
     * outage (5xx, network/timeout), throws on configuration errors
     * (4xx, malformed response).
     */
    rerank(input: CohereRerankInput): Promise<readonly CohereRerankResult[] | null>;
}

export interface CohereRerankClientDeps {
    readonly apiKey: string;
    readonly model?: string;
    readonly timeoutMs?: number;
    /**
     * Test seam — production wires `globalThis.fetch`. The signature
     * matches `fetch` so a real `fetch` implementation can be passed
     * straight in.
     */
    readonly fetch?: typeof globalThis.fetch;
}

interface CohereRerankResponse {
    readonly results: readonly {
        readonly index: number;
        readonly relevance_score: number;
    }[];
}

const isRerankResponse = (value: unknown): value is CohereRerankResponse => {
    if (value === null || typeof value !== 'object') return false;
    const results = (value as { results?: unknown }).results;
    if (!Array.isArray(results)) return false;
    return results.every((r) => {
        return (
            r !== null
            && typeof r === 'object'
            && typeof (r as { index?: unknown }).index === 'number'
            && typeof (r as { relevance_score?: unknown }).relevance_score === 'number'
        );
    });
};

export const createCohereRerankClient = (
    deps: CohereRerankClientDeps,
): CohereRerankClient => {
    const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    const model = deps.model
        ?? process.env['COHERE_RERANK_MODEL']
        ?? DEFAULT_COHERE_RERANK_MODEL;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return {
        rerank: async (input) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response: Response;
            try {
                response = await fetchImpl(COHERE_RERANK_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${deps.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model,
                        query: input.query,
                        documents: input.documents,
                        top_n: input.topN,
                    }),
                    signal: controller.signal,
                });
            } catch (err) {
                logger.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'cohere rerank: network/timeout — falling through to Pinecone hybrid score',
                );
                return null;
            } finally {
                clearTimeout(timer);
            }

            if (response.status >= 500) {
                logger.warn(
                    { status: response.status },
                    'cohere rerank: 5xx — falling through to Pinecone hybrid score',
                );
                return null;
            }
            if (!response.ok) {
                throw new Error(`cohere rerank ${response.status}: ${await response.text()}`);
            }

            const body: unknown = await response.json();
            if (!isRerankResponse(body)) {
                throw new Error('cohere rerank: malformed response shape');
            }
            return body.results.map((r) => ({
                index: r.index,
                relevanceScore: r.relevance_score,
            }));
        },
    };
};
