import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  inlineMarkdownToNodes,
  renderInlineMarkdown,
  splitParagraphs,
} from './copilotMarkdown';

function renderInline(text: string): string {
  return renderToStaticMarkup(<>{renderInlineMarkdown(text, 'k')}</>);
}

function renderInlineList(text: string): string {
  return renderToStaticMarkup(<>{inlineMarkdownToNodes(text, 'k')}</>);
}

describe('inlineMarkdownToNodes', () => {
  it('renders **bold** as <strong>', () => {
    expect(renderInline('Active diagnoses: **Diabetes**.')).toBe(
      'Active diagnoses: <strong>Diabetes</strong>.',
    );
  });

  it('renders __bold__ as <strong>', () => {
    expect(renderInline('it is __very__ important')).toBe(
      'it is <strong>very</strong> important',
    );
  });

  it('renders *italic* as <em>', () => {
    expect(renderInline('that is *important* now')).toBe(
      'that is <em>important</em> now',
    );
  });

  it('does not treat underscores inside identifiers as italic', () => {
    expect(renderInline('see patient_id field')).toBe('see patient_id field');
  });

  it('renders inline `code`', () => {
    expect(renderInline('the code is `E11.9` today')).toBe(
      'the code is <code>E11.9</code> today',
    );
  });

  it('passes through plain text untouched', () => {
    expect(renderInline('Plain prose stays plain.')).toBe(
      'Plain prose stays plain.',
    );
  });

  it('escapes HTML in plain runs', () => {
    expect(renderInlineList('use <script>alert(1)</script> here')).toBe(
      'use &lt;script&gt;alert(1)&lt;/script&gt; here',
    );
  });

  it('handles nested bold-then-italic', () => {
    expect(renderInline('this is **really *very* important**')).toBe(
      'this is <strong>really <em>very</em> important</strong>',
    );
  });
});

describe('splitParagraphs', () => {
  it('returns an empty array for blank input', () => {
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('   ')).toEqual([]);
  });

  it('keeps a single paragraph as a single-element array', () => {
    expect(splitParagraphs('one paragraph here')).toEqual(['one paragraph here']);
  });

  it('splits on blank lines', () => {
    expect(splitParagraphs('a\n\nb')).toEqual(['a', 'b']);
  });

  it('inserts a paragraph break before bolded headlines', () => {
    const text =
      "intro prose. **Medication discrepancies (safety-critical):** the chart shows X. **Allergy discrepancies:** Sulfa is missing.";
    const split = splitParagraphs(text);
    expect(split).toHaveLength(3);
    expect(split[0]).toBe('intro prose.');
    expect(split[1]?.startsWith('**Medication discrepancies')).toBe(true);
    expect(split[2]?.startsWith('**Allergy discrepancies')).toBe(true);
  });

  it('breaks numbered "(N)" follow-up runs onto their own lines', () => {
    const text = '**Suggested follow-ups:** (1) reconcile statin (2) add Lisinopril (3) confirm allergies';
    const paragraphs = splitParagraphs(text);
    // The bolded headline still becomes its own paragraph; the
    // numbered list collapses into a multi-line paragraph.
    expect(paragraphs).toHaveLength(1);
    const lines = paragraphs[0]!.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((ln) => ln.startsWith('(1)'))).toBe(true);
    expect(lines.some((ln) => ln.startsWith('(2)'))).toBe(true);
    expect(lines.some((ln) => ln.startsWith('(3)'))).toBe(true);
  });
});
