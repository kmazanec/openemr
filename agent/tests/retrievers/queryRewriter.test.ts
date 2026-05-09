import { describe, expect, it } from 'vitest';

import {
    REWRITE_VARIANT_KINDS,
    assembleResult,
    createStubQueryRewriter,
} from '../../src/retrievers/queryRewriter.js';

describe('assembleResult (query rewriter projection)', () => {
    const goodParse = {
        paraphrase: 'At what age does USPSTF advise starting colorectal cancer screening?',
        step_back: 'USPSTF colorectal screening recommendations',
        terminology: 'colon cancer screening age guidelines',
    };

    it('returns the original at queries[0] and three variants in declared order', () => {
        const r = assembleResult('When should colorectal cancer screening start?', goodParse);
        expect(r.queries[0]).toBe('When should colorectal cancer screening start?');
        expect(r.queries).toHaveLength(4);
        expect(r.variants.map((v) => v.kind)).toEqual(['paraphrase', 'step_back', 'terminology']);
    });

    it('every variant kind in REWRITE_VARIANT_KINDS is produced', () => {
        const r = assembleResult('q', goodParse);
        for (const kind of REWRITE_VARIANT_KINDS) {
            expect(r.variants.some((v) => v.kind === kind)).toBe(true);
        }
    });

    it('drops a variant whose normalized text equals the original', () => {
        const r = assembleResult('Heart attack risk', {
            paraphrase: 'heart attack risk',
            step_back: 'cardiovascular event prevention',
            terminology: 'myocardial infarction risk',
        });
        // The paraphrase collides with the original (case-insensitive,
        // whitespace-trimmed) so it drops out.
        expect(r.variants.map((v) => v.kind)).toEqual(['step_back', 'terminology']);
        expect(r.queries).toHaveLength(3);
    });

    it('drops cross-variant duplicates so the fused set is not padded', () => {
        const r = assembleResult('q', {
            paraphrase: 'colon cancer screening',
            step_back: 'colon cancer screening',
            terminology: 'colorectal cancer screening',
        });
        // step_back collides with paraphrase; terminology survives.
        expect(r.variants.map((v) => v.kind)).toEqual(['paraphrase', 'terminology']);
    });

    it('trims whitespace on every variant', () => {
        const r = assembleResult('q', {
            paraphrase: '  one  ',
            step_back: '\ttwo\n',
            terminology: 'three  ',
        });
        expect(r.variants.map((v) => v.text)).toEqual(['one', 'two', 'three']);
    });
});

describe('createStubQueryRewriter', () => {
    it('returns the fixed result for a sync function', async () => {
        const rewriter = createStubQueryRewriter((q) => ({
            original: q,
            variants: [{ kind: 'paraphrase', text: `${q} (rewritten)` }],
            queries: [q, `${q} (rewritten)`],
        }));
        const r = await rewriter.rewrite('foo');
        expect(r.queries).toEqual(['foo', 'foo (rewritten)']);
    });

    it('awaits an async fixture function', async () => {
        const rewriter = createStubQueryRewriter((q) =>
            Promise.resolve({ original: q, variants: [], queries: [q] }),
        );
        const r = await rewriter.rewrite('bar');
        expect(r.queries).toEqual(['bar']);
    });
});
