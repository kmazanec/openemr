/**
 * Tests for the Clinical Co-Pilot panel's inline-markdown helpers.
 *
 * The synthesizer occasionally emits structure markers (`**Bold:**`
 * headlines, paragraph breaks, ordered lists like "(1) ...") that the
 * panel was rendering verbatim — long briefings appeared as a wall of
 * text peppered with literal asterisks. The two helpers under test
 * are pure (no DOM, no fetch) so we drive them directly from node.
 */

const helpers = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

const { renderInlineMarkdown, splitMarkdownParagraphs } = helpers;

describe('renderInlineMarkdown', () => {
    test('renders **bold** as <strong>', () => {
        expect(renderInlineMarkdown('Active diagnoses: **Diabetes**.'))
            .toBe('Active diagnoses: <strong>Diabetes</strong>.');
    });

    test('renders __bold__ as <strong>', () => {
        expect(renderInlineMarkdown('it is __very__ important'))
            .toBe('it is <strong>very</strong> important');
    });

    test('renders *italic* as <em>', () => {
        expect(renderInlineMarkdown('that is *important* now'))
            .toBe('that is <em>important</em> now');
    });

    test('does not split underscores inside identifiers', () => {
        expect(renderInlineMarkdown('see patient_id field'))
            .toBe('see patient_id field');
    });

    test('renders inline `code`', () => {
        expect(renderInlineMarkdown('the code is `E11.9` today'))
            .toBe('the code is <code>E11.9</code> today');
    });

    test('passes through plain text untouched', () => {
        expect(renderInlineMarkdown('Plain prose stays plain.'))
            .toBe('Plain prose stays plain.');
    });

    test('handles nested bold + italic', () => {
        expect(renderInlineMarkdown('this is **really *very* important**'))
            .toBe('this is <strong>really <em>very</em> important</strong>');
    });
});

describe('splitMarkdownParagraphs', () => {
    test('returns an empty array for blank input', () => {
        expect(splitMarkdownParagraphs('')).toEqual([]);
        expect(splitMarkdownParagraphs('   ')).toEqual([]);
    });

    test('keeps a single paragraph as a single-element array', () => {
        expect(splitMarkdownParagraphs('one paragraph here'))
            .toEqual(['one paragraph here']);
    });

    test('splits on blank lines', () => {
        expect(splitMarkdownParagraphs('a\n\nb')).toEqual(['a', 'b']);
    });

    test('inserts a paragraph break before bolded headlines', () => {
        const text =
            "intro prose. **Medication discrepancies (safety-critical):** the chart shows X. **Allergy discrepancies:** Sulfa is missing.";
        const split = splitMarkdownParagraphs(text);
        expect(split).toHaveLength(3);
        expect(split[0]).toBe('intro prose.');
        expect(split[1].startsWith('**Medication discrepancies')).toBe(true);
        expect(split[2].startsWith('**Allergy discrepancies')).toBe(true);
    });

    test('breaks numbered "(N)" follow-ups onto their own lines', () => {
        const text = 'Suggested follow-ups: (1) reconcile statin (2) add Lisinopril (3) confirm allergies';
        const paragraphs = splitMarkdownParagraphs(text);
        expect(paragraphs).toHaveLength(1);
        const lines = paragraphs[0].split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(3);
        expect(lines.some((ln) => ln.startsWith('(1)'))).toBe(true);
        expect(lines.some((ln) => ln.startsWith('(3)'))).toBe(true);
    });
});
