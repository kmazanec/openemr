import { createHmac } from 'node:crypto';

import { getCurrentRunTree } from 'langsmith/traceable';

import { scanForPhi } from './phiTraceScanner.js';

/**
 * §6.1 LangSmith trace metadata helpers.
 *
 * Per-tool latency / token counts / cost / verification outcome live on
 * each LangSmith run as `metadata` so a downstream cost-projection
 * dashboard can aggregate without parsing every span body. Identity tags
 * are *hashed* HMAC-SHA256 with `LANGSMITH_TAG_SALT` so the trace surface
 * stays PHI-free even when LangSmith is sampled.
 */

export interface PriceEntry {
    /** Dollars per 1M input tokens. */
    readonly input: number;
    /** Dollars per 1M output tokens. */
    readonly output: number;
}

/**
 * Public Anthropic list-prices, USD per million tokens. Source: Anthropic
 * pricing page as of 2026-04. Add new entries here when the synthesizer
 * model changes; unknown models cost 0 (we'd rather see "no cost" in the
 * trace and notice than silently estimate from a stale table).
 */
export const PRICE_TABLE_USD_PER_MILLION: Readonly<Record<string, PriceEntry>> = {
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-opus-4-7': { input: 15, output: 75 },
    'claude-haiku-4-5': { input: 0.8, output: 4 },
};

/**
 * Anthropic prompt-caching multipliers, applied against `PriceEntry.input`.
 * Source: Anthropic pricing page (5-minute ephemeral cache).
 *
 *   - Cache writes (cache_creation_input_tokens) are billed at 1.25× the
 *     base input rate — a one-time premium when the prefix is first stored.
 *   - Cache reads  (cache_read_input_tokens)     are billed at 0.10× the
 *     base input rate — the 90% discount that makes caching worthwhile.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface CostForUsageInput {
    readonly model: string;
    /**
     * Total input tokens reported by LangChain's `usage_metadata`, which
     * already sums regular + cache_creation + cache_read. The cost calc
     * splits this back into three buckets and applies the multipliers
     * above. Callers should pass `usage_metadata.input_tokens` verbatim.
     */
    readonly inputTokens: number;
    readonly outputTokens: number;
    /**
     * From `usage_metadata.input_token_details.cache_creation`. 0 (or
     * undefined) when caching is off or the request did not write to the
     * cache. Counted toward `inputTokens`; do not subtract before passing.
     */
    readonly cacheCreationInputTokens?: number;
    /**
     * From `usage_metadata.input_token_details.cache_read`. 0 (or
     * undefined) when caching is off or this was a cache miss. Counted
     * toward `inputTokens`; do not subtract before passing.
     */
    readonly cacheReadInputTokens?: number;
}

export const costForUsage = ({
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens = 0,
    cacheReadInputTokens = 0,
}: CostForUsageInput): number => {
    const price = PRICE_TABLE_USD_PER_MILLION[model];
    if (price === undefined) {
        return 0;
    }
    // `inputTokens` from LangChain already contains the cached buckets.
    // Pull them out so the regular-rate slice is what's left after the
    // creation + read tokens are accounted for at their own multipliers.
    const regularInputTokens = Math.max(
        0,
        inputTokens - cacheCreationInputTokens - cacheReadInputTokens,
    );
    const inputCost =
        regularInputTokens * price.input
        + cacheCreationInputTokens * price.input * CACHE_WRITE_MULTIPLIER
        + cacheReadInputTokens * price.input * CACHE_READ_MULTIPLIER;
    return (inputCost + outputTokens * price.output) / 1_000_000;
};

/**
 * Produce a 12-hex-char HMAC of an internal ID. Used as a LangSmith tag
 * so we can correlate runs to the same clinician/patient post-hoc
 * without ever shipping the raw ID. Salt rotation invalidates prior
 * correlations on purpose.
 */
export const hashIdForTrace = (id: string, salt: string): string => {
    return createHmac('sha256', salt).update(id).digest('hex').slice(0, 12);
};

/**
 * Resolve the HMAC salt used by `hashIdForTrace`. Exported so other
 * trace-emitting nodes can hash their own identifiers (e.g. the C.1
 * `documentEvidenceRetriever` hashes the model's free-text query) with
 * the same default-salt rotation semantics as identity tags.
 */
export const tagSalt = (): string => process.env['LANGSMITH_TAG_SALT'] ?? 'agent-counters';

export interface IdentityTags {
    readonly clinicianHash: string;
    readonly patientHash: string;
}

export const buildIdentityTags = (input: {
    readonly clinicianId: string;
    readonly patientId: string;
}): IdentityTags => {
    const salt = tagSalt();
    return {
        clinicianHash: hashIdForTrace(input.clinicianId, salt),
        patientHash: hashIdForTrace(input.patientId, salt),
    };
};

/**
 * Merge the supplied keys into the current run's metadata, if one
 * exists. Outside a `traceable()` (e.g. when LangSmith tracing is off,
 * or in unit tests) this is a quiet no-op — `getCurrentRunTree()`
 * throws in that case, and we never want instrumentation to fail the
 * actual call.
 */
export const setRunMetadata = (extra: Record<string, unknown>): void => {
    try {
        const tree = getCurrentRunTree();
        tree.metadata = { ...(tree.metadata ?? {}), ...extra };
    } catch {
        // No active run tree — tracing is off or we're outside any
        // traceable. Nothing to do.
    }
};

const PHI_SCRUB_SENTINEL = '[redacted: phi-detected]';

/**
 * Scrub an LLM-emitted value before it lands on a LangSmith trace. The
 * trace metadata channel bypasses both Pino redaction (logger-only) and
 * `LANGSMITH_HIDE_INPUTS / OUTPUTS` (which only blanks the `inputs` and
 * `outputs` fields, not `metadata`). When the supervisor's free-text
 * `reason` / `narration` / `args` blend a patient name into the model
 * output, that string lands on the trace indefinitely.
 *
 * Strategy: walk the value with `scanForPhi`. If it contains a PHI-shaped
 * key, an SSN/MRN/phone pattern, or a configured canary, replace the
 * whole value with a sentinel. Cardinality is preserved at the field
 * level (the trace still records "this slot exists") without leaking
 * the offending content.
 *
 * Strings, arrays, and plain objects are all supported; primitives that
 * cannot carry PHI (numbers, booleans, null/undefined) pass through
 * unchanged. Configurable canaries allow tests to seed known fixture
 * names so a regression that uploads a real prompt is caught.
 */
export const scrubLlmTextForTrace = <T,>(
    value: T,
    options: {
        readonly canaries?: readonly string[];
    } = {},
): T | typeof PHI_SCRUB_SENTINEL => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    const findings = scanForPhi(value, {
        ...(options.canaries !== undefined ? { canaries: options.canaries } : {}),
    });
    if (findings.length > 0) {
        return PHI_SCRUB_SENTINEL;
    }
    return value;
};

export { PHI_SCRUB_SENTINEL };
