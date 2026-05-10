import { describe, expect, it } from 'vitest';

import { findQuoteSpanInText } from './quoteSearch';

describe('findQuoteSpanInText', () => {
    it('returns null for null / empty quote', () => {
        expect(findQuoteSpanInText('hello world', null)).toBeNull();
        expect(findQuoteSpanInText('hello world', '')).toBeNull();
        expect(findQuoteSpanInText('hello world', '   ')).toBeNull();
    });

    it('finds an exact substring match', () => {
        const text = 'Past Medical History:\nEssential hypertension (I10)';
        const span = findQuoteSpanInText(text, 'Essential hypertension (I10)');
        expect(span).toEqual([22, 50]);
        expect(text.slice(22, 50)).toBe('Essential hypertension (I10)');
    });

    it('trims the quote before searching', () => {
        const text = 'Hyperlipidemia (E78.5)';
        expect(findQuoteSpanInText(text, '  Hyperlipidemia (E78.5)  ')).toEqual([0, 22]);
    });

    it('returns null when the quote is genuinely absent', () => {
        const text = 'Past Medical History: Essential hypertension (I10)';
        expect(findQuoteSpanInText(text, 'Diabetes mellitus')).toBeNull();
    });

    it('matches across paragraph boundaries when the quote collapses whitespace', () => {
        // Quote uses a single space where the docx walker emits `\n`.
        const text = 'Reason for Referral: I am referring Ms. Chen\nfor lipid management.';
        const span = findQuoteSpanInText(
            text,
            'I am referring Ms. Chen for lipid management.',
        );
        expect(span).not.toBeNull();
        const sliced = text.slice(span![0], span![1]);
        // The matched span should contain the same words (the
        // intervening newline is preserved in the original text).
        expect(sliced).toContain('I am referring Ms. Chen');
        expect(sliced).toContain('for lipid management.');
    });

    it('matches when the quote uses tabs but the source uses runs of spaces', () => {
        const text = 'Lisinopril\t10 mg\tPO daily';
        const span = findQuoteSpanInText(text, 'Lisinopril 10 mg PO daily');
        expect(span).not.toBeNull();
        expect(text.slice(span![0], span![1])).toBe('Lisinopril\t10 mg\tPO daily');
    });

    it('returns the first occurrence when the quote appears multiple times', () => {
        const text = 'NKDA\nAllergies: NKDA';
        const span = findQuoteSpanInText(text, 'NKDA');
        expect(span).toEqual([0, 4]);
    });
});
