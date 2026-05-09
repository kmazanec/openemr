import { describe, expect, it } from 'vitest';

import {
    CACHE_READ_MULTIPLIER,
    CACHE_WRITE_MULTIPLIER,
    costForUsage,
    hashIdForTrace,
    PHI_SCRUB_SENTINEL,
    PRICE_TABLE_USD_PER_MILLION,
    scrubLlmTextForTrace,
} from '../../src/observability/traceMetadata.js';

describe('costForUsage', () => {
    it('computes dollar cost from token usage for a known model', () => {
        const price = PRICE_TABLE_USD_PER_MILLION['claude-sonnet-4-6']!;
        const cost = costForUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 1_000_000,
            outputTokens: 500_000,
        });
        const expected = price.input + (price.output * 0.5);
        expect(cost).toBeCloseTo(expected, 6);
    });

    it('returns 0 for an unknown model rather than throwing', () => {
        const cost = costForUsage({
            model: 'unknown-model-name',
            inputTokens: 1000,
            outputTokens: 500,
        });
        expect(cost).toBe(0);
    });

    it('returns 0 when token counts are zero', () => {
        const cost = costForUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 0,
            outputTokens: 0,
        });
        expect(cost).toBe(0);
    });

    it('prices cache-read tokens at the discounted rate', () => {
        const price = PRICE_TABLE_USD_PER_MILLION['claude-sonnet-4-6']!;
        // 800k regular + 200k cached read; LangChain reports the sum.
        const cost = costForUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadInputTokens: 200_000,
        });
        const expected =
            (800_000 * price.input + 200_000 * price.input * CACHE_READ_MULTIPLIER) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 6);
        // Sanity: caching this slice is cheaper than the no-cache baseline.
        const baseline = price.input;
        expect(cost).toBeLessThan(baseline);
    });

    it('prices cache-write tokens at the premium rate', () => {
        const price = PRICE_TABLE_USD_PER_MILLION['claude-sonnet-4-6']!;
        const cost = costForUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheCreationInputTokens: 200_000,
        });
        const expected =
            (800_000 * price.input + 200_000 * price.input * CACHE_WRITE_MULTIPLIER) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 6);
        // Sanity: writing the cache costs more than not caching at all.
        expect(cost).toBeGreaterThan(price.input);
    });

    it('handles all three input buckets at once (write + read + regular)', () => {
        const price = PRICE_TABLE_USD_PER_MILLION['claude-sonnet-4-6']!;
        const cost = costForUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheCreationInputTokens: 100_000,
            cacheReadInputTokens: 700_000,
        });
        const expected =
            (200_000 * price.input
                + 100_000 * price.input * CACHE_WRITE_MULTIPLIER
                + 700_000 * price.input * CACHE_READ_MULTIPLIER
                + 100_000 * price.output) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 6);
    });

    it('clamps the regular-input slice at zero rather than going negative', () => {
        // Defensive: if cached counts somehow exceed the LangChain total
        // (provider bug, future schema drift), cost stays meaningful
        // instead of subtracting away to a negative dollar figure.
        const cost = costForUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 100,
            outputTokens: 0,
            cacheReadInputTokens: 500,
        });
        expect(cost).toBeGreaterThanOrEqual(0);
    });
});

describe('hashIdForTrace', () => {
    it('produces a stable, short hash', () => {
        const a = hashIdForTrace('user-123', 'salt');
        const b = hashIdForTrace('user-123', 'salt');
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{12}$/);
    });

    it('different inputs produce different hashes', () => {
        const a = hashIdForTrace('user-1', 'salt');
        const b = hashIdForTrace('user-2', 'salt');
        expect(a).not.toBe(b);
    });

    it('different salts produce different hashes for the same input', () => {
        const a = hashIdForTrace('user-1', 'salt-a');
        const b = hashIdForTrace('user-1', 'salt-b');
        expect(a).not.toBe(b);
    });

    it('does not echo the raw id back in the hash', () => {
        const raw = 'user-with-recognizable-string-12345';
        const hashed = hashIdForTrace(raw, 'salt');
        expect(hashed).not.toContain('user-with');
        expect(hashed).not.toContain('12345');
    });
});

describe('scrubLlmTextForTrace', () => {
    // Trace metadata bypasses Pino redaction AND LANGSMITH_HIDE_*; the
    // scrubber is the last line of defense for LLM-emitted free text
    // (supervisor `reason` / `narration` / `args`) before it lands on
    // a LangSmith run's `metadata` field.

    it('passes plain non-PHI strings through unchanged', () => {
        expect(scrubLlmTextForTrace('checking USPSTF on statin primary prevention')).toBe(
            'checking USPSTF on statin primary prevention',
        );
    });

    it('passes primitives through unchanged', () => {
        expect(scrubLlmTextForTrace(42)).toBe(42);
        expect(scrubLlmTextForTrace(true)).toBe(true);
        expect(scrubLlmTextForTrace(null)).toBe(null);
        expect(scrubLlmTextForTrace(undefined)).toBe(undefined);
    });

    it('returns the sentinel when a string contains an SSN', () => {
        expect(scrubLlmTextForTrace('Looking up record for 123-45-6789')).toBe(PHI_SCRUB_SENTINEL);
    });

    it('returns the sentinel when a string contains an MRN-prefix', () => {
        expect(scrubLlmTextForTrace('Pulling chart for MRN-12345')).toBe(PHI_SCRUB_SENTINEL);
    });

    it('returns the sentinel when a string contains a US phone', () => {
        expect(scrubLlmTextForTrace('Caller ID 555-867-5309')).toBe(PHI_SCRUB_SENTINEL);
    });

    it('returns the sentinel when a configured canary appears', () => {
        // The supervisor's narration could blend a fixture name into
        // its rationale ("Checking Maya's prior A1c…"). Configurable
        // canaries seed those fixture identifiers.
        expect(
            scrubLlmTextForTrace("Checking Maya's prior A1c", {
                canaries: ['Maya', 'Patel'],
            }),
        ).toBe(PHI_SCRUB_SENTINEL);
    });

    it('returns the sentinel for an object with a PHI-shaped key (deep)', () => {
        // Supervisor `args` is a record. A model that emits {patient:
        // {firstName: 'Maya'}} as part of args lands a PHI-named slot
        // in the trace; the scrubber drops the whole value.
        const value = { lookup: { patient: { firstName: 'Maya' } } };
        expect(scrubLlmTextForTrace(value)).toBe(PHI_SCRUB_SENTINEL);
    });

    it('passes a clean object through unchanged', () => {
        const args = { handoff: 'evidenceRetriever', query: 'statin primary prevention' };
        expect(scrubLlmTextForTrace(args)).toEqual(args);
    });

    it('returns the sentinel for a clean string when paired with a matching canary set', () => {
        // Sanity: canaries tighten the gate; without one the same
        // string passes; with one the same string is sentinelled.
        const text = 'rate_limited on getLabHistory';
        expect(scrubLlmTextForTrace(text)).toBe(text);
        expect(
            scrubLlmTextForTrace('querying labs for Margaret', {
                canaries: ['Margaret'],
            }),
        ).toBe(PHI_SCRUB_SENTINEL);
    });
});
