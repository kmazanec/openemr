import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { createLogger } from '../observability/logger.js';

/**
 * Query rewriter for the guideline evidence retriever.
 *
 * The original `evidenceRetriever` ran a single user-shaped query
 * against Pinecone hybrid + Cohere rerank. Clinical questions arrive
 * with heavy synonym variation — "heart attack" vs "myocardial
 * infarction", "high blood pressure" vs "hypertension", "sugar
 * diabetes" vs "type 2 diabetes mellitus" — and a single phrasing
 * routinely misses chunks that carry the publisher's preferred term.
 *
 * The rewriter expands the original query into N variants (default 3):
 *
 *  1. **Literal paraphrase** — same intent, different wording. Closes
 *     the gap when the user phrases the question differently from the
 *     guideline body.
 *  2. **Step-back / generalized** — a more abstract framing. Helps when
 *     the question is over-specified relative to how guidelines are
 *     written ("statin for 52-year-old with LDL 145 and family history"
 *     → "statin primary prevention").
 *  3. **Terminology shift** — lay ↔ clinical translation. Specifically
 *     attacks the medical-synonym mismatch that hybrid retrieval cannot
 *     fully solve on its own.
 *
 * The original query is always retained as the first variant so the
 * fused candidate set is a strict superset of the single-query result.
 *
 * Outage policy: a thrown error from the LLM call surfaces as a
 * `QueryRewriterUnavailableError`. The retriever catches it and falls
 * back to single-query retrieval — degraded mode, not a hard failure.
 *
 * Cost shape: ~150 input tokens (system + question) + ~120 output
 * tokens per call. The system prompt is marked as a prompt-cache
 * breakpoint so subsequent turns within the cache TTL pay ~10% read
 * rate on input.
 */

const logger = createLogger('retrievers:queryRewriter');

export const DEFAULT_REWRITE_VARIANT_COUNT = 3;
const DEFAULT_REWRITER_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Variant categories the rewriter is asked to produce. Single closed
 * enum so the eval suite can assert that each category is present.
 */
export const REWRITE_VARIANT_KINDS = ['paraphrase', 'step_back', 'terminology'] as const;
export type RewriteVariantKind = (typeof REWRITE_VARIANT_KINDS)[number];

export interface RewriteVariant {
    readonly kind: RewriteVariantKind;
    readonly text: string;
}

export interface RewriteResult {
    /** The original query, unchanged. Always position 0 in `queries`. */
    readonly original: string;
    /** Generated variants, in `REWRITE_VARIANT_KINDS` order. */
    readonly variants: readonly RewriteVariant[];
    /** Convenience: original + variants as a flat ordered list. */
    readonly queries: readonly string[];
}

export interface QueryRewriter {
    rewrite(query: string): Promise<RewriteResult>;
}

/**
 * Thrown when the rewriter LLM call fails. The retriever catches and
 * falls back to single-query mode.
 */
export class QueryRewriterUnavailableError extends Error {
    constructor(message: string, options?: { cause: unknown }) {
        super(message, options);
        this.name = 'QueryRewriterUnavailableError';
    }
}

const RewriteSchema = z.object({
    paraphrase: z.string().min(1),
    step_back: z.string().min(1),
    terminology: z.string().min(1),
});

const SYSTEM_PROMPT = `You rewrite a clinician's clinical-guideline question into three alternate phrasings so that hybrid retrieval (BM25 + dense embeddings) over a corpus of clinical guidelines (USPSTF, ADA, CDC, AGS Beers) can find the relevant section even when the user's wording does not match the publisher's wording.

Output exactly three rewrites in a structured object:
1. paraphrase — same intent and specificity as the original, different wording. Keep all named entities (drugs, diseases, age ranges, lab analytes) but vary the verbs/connectives. Example: "When should colorectal cancer screening start?" → "At what age does USPSTF recommend beginning colorectal cancer screening?"
2. step_back — a more general framing of the question. Drop patient-specific details and ask the underlying clinical-policy question. Example: "Should this 52-year-old man with LDL 145 be on a statin?" → "USPSTF recommendation on statin therapy for primary prevention of cardiovascular disease in adults".
3. terminology — translate any lay terms to clinical/professional terms (or vice versa if the user already used clinical terms — translate to common synonyms a guideline body might use). Examples: "heart attack" ↔ "myocardial infarction"; "high blood pressure" ↔ "hypertension"; "sugar diabetes" ↔ "type 2 diabetes mellitus"; "water pill" ↔ "diuretic"; "cholesterol meds" ↔ "lipid-lowering therapy / statin".

Rules:
- Each rewrite must be a single search query string, 4–20 words. No prose, no leading "Search:" labels, no quotes.
- Preserve clinical accuracy. Do NOT invent diagnoses, drugs, or numbers that are not in the original. If a step-back removes a number, it removes it; it does not change it.
- Do not output the original query verbatim — that is already in the candidate set.
- Each rewrite must be meaningfully different from the others. If the user's question is already maximally general (e.g. "USPSTF screening recommendations"), make step_back a sibling rephrase rather than a duplicate.
- If the input is not a clinical question, still produce three plausible search variants; the retriever will sort it out downstream.`;

export interface AnthropicQueryRewriterOptions {
    readonly model?: string;
    readonly apiKey?: string;
    readonly timeoutMs?: number;
}

/**
 * Build the production rewriter backed by Claude Haiku +
 * `withStructuredOutput(RewriteSchema)`.
 *
 *   ANTHROPIC_MODEL_QUERY_REWRITER → defaults to Haiku 4.5
 *
 * Haiku is the right choice here because the task is pure paraphrase —
 * routing accuracy and rationale aren't load-bearing the way they are
 * in the supervisor. The cost saving (Haiku ≈ 1/12th Sonnet on input,
 * 1/5th on output) compounds at every retrieval-shaped turn.
 */
export const createAnthropicQueryRewriter = (
    options: AnthropicQueryRewriterOptions = {},
): QueryRewriter => {
    const model =
        options.model ?? process.env['ANTHROPIC_MODEL_QUERY_REWRITER'] ?? DEFAULT_REWRITER_MODEL;
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('ANTHROPIC_API_KEY is required to build the default query rewriter');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const structured = new ChatAnthropic({
        model,
        apiKey,
        temperature: 0,
    }).withStructuredOutput(RewriteSchema, { name: 'query_rewrite' });

    return {
        rewrite: async (query: string): Promise<RewriteResult> => {
            try {
                // Wall-clock bound via Promise.race — a runaway rewriter
                // call should not hold the conversational graph open.
                // The SDK's constructor does not expose a `timeout`
                // field, so we enforce it at this layer.
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(
                        () => reject(new Error(`queryRewriter: timed out after ${timeoutMs}ms`)),
                        timeoutMs,
                    );
                });
                try {
                    const parsed = await Promise.race([
                        structured.invoke([
                            new SystemMessage({
                                content: [
                                    {
                                        type: 'text',
                                        text: SYSTEM_PROMPT,
                                        cache_control: { type: 'ephemeral' },
                                    },
                                ],
                            }),
                            new HumanMessage(`Rewrite this clinical question:\n\n${query}`),
                        ]),
                        timeoutPromise,
                    ]);
                    return assembleResult(query, parsed);
                } finally {
                    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                }
            } catch (err) {
                logger.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'queryRewriter: LLM call failed — caller should fall back to single-query retrieval',
                );
                throw new QueryRewriterUnavailableError(
                    'queryRewriter: LLM call failed',
                    { cause: err },
                );
            }
        },
    };
};

/**
 * Assemble a `RewriteResult` from the parsed structured output.
 * Exported so unit tests can build deterministic results without a
 * full ChatAnthropic stub. De-duplicates variants that collide with
 * the original (case-insensitive, whitespace-trimmed) so the fused
 * candidate set isn't padded by no-op queries.
 */
export const assembleResult = (
    original: string,
    parsed: z.infer<typeof RewriteSchema>,
): RewriteResult => {
    const variants: RewriteVariant[] = [
        { kind: 'paraphrase', text: parsed.paraphrase.trim() },
        { kind: 'step_back', text: parsed.step_back.trim() },
        { kind: 'terminology', text: parsed.terminology.trim() },
    ];

    const seen = new Set<string>([normalize(original)]);
    const unique: RewriteVariant[] = [];
    for (const v of variants) {
        const key = normalize(v.text);
        if (key.length === 0 || seen.has(key)) continue;
        seen.add(key);
        unique.push(v);
    }

    return {
        original,
        variants: unique,
        queries: [original, ...unique.map((v) => v.text)],
    };
};

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Test seam: a `QueryRewriter` that returns a fixed result. Used by
 * unit tests and the per-MR Vitest gate so structural assertions
 * don't burn an Anthropic call.
 */
export const createStubQueryRewriter = (
    fixed: (query: string) => RewriteResult | Promise<RewriteResult>,
): QueryRewriter => ({
    rewrite: async (query) => fixed(query),
});
