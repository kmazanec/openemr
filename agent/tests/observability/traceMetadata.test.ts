import { describe, expect, it } from 'vitest';

import {
    costForUsage,
    hashIdForTrace,
    PRICE_TABLE_USD_PER_MILLION,
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
