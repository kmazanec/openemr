import { createHmac } from 'node:crypto';

import { getCurrentRunTree } from 'langsmith/traceable';

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

export interface CostForUsageInput {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
}

export const costForUsage = ({ model, inputTokens, outputTokens }: CostForUsageInput): number => {
    const price = PRICE_TABLE_USD_PER_MILLION[model];
    if (price === undefined) {
        return 0;
    }
    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
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

const tagSalt = (): string => process.env['LANGSMITH_TAG_SALT'] ?? 'agent-counters';

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
