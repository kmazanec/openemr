import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';

/**
 * Tiny markdown renderer for assistant prose. The agent occasionally
 * emits structure markers (`**Headline:**`, paragraph breaks, ordered
 * lists like "(1) ...") that the panel was rendering verbatim — long
 * briefings appeared as a wall of text with literal asterisks.
 *
 * We only handle the inline subset the synthesizer actually produces.
 * Anything fancier (nested lists, tables, links) is out of scope: the
 * agent's contract emits structured `[source]` chips, not link syntax,
 * so a full markdown engine would buy us nothing and add a parser as
 * an attack surface.
 *
 * Supported:
 *   - **bold** / __bold__ → <strong>
 *   - *italic* / _italic_ → <em>
 *   - `code` → <code>
 *   - paragraph splits on a blank line OR on whitespace immediately
 *     before a `**Headline:**` token (the synthesizer emits its
 *     section markers without explicit newlines)
 *   - "(N)" / "1. " ordered-list markers force a line break before
 *     the marker so numbered follow-ups don't run together
 *
 * The tokenizer operates on plain text — it never accepts HTML — so
 * React's JSX-time escaping is the only sanitization the output
 * needs.
 */

/**
 * Split a paragraph's text into inline runs. Recognizes **bold**,
 * *italic* / _italic_, and `code`. Falls back to plain text for
 * everything else. Mismatched delimiters are rendered verbatim
 * rather than swallowing the run — matches GitHub's behavior and
 * keeps clinical text honest.
 */
export function inlineMarkdownToNodes(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let runId = 0;
  const pushPlain = (): void => {
    if (buf.length === 0) return;
    out.push(buf);
    buf = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    // Bold: **...** or __...__ (greedy match — find the next pair of
    // the same delimiter on the same paragraph).
    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const delim = c + c;
      const close = text.indexOf(delim, i + 2);
      if (close !== -1 && close > i + 2) {
        pushPlain();
        const inner = text.slice(i + 2, close);
        runId += 1;
        out.push(
          createElement(
            'strong',
            { key: `${keyPrefix}-b-${String(runId)}` },
            inlineMarkdownToNodes(inner, `${keyPrefix}-b-${String(runId)}-i`),
          ),
        );
        i = close + 2;
        continue;
      }
    }
    // Italic: single * or _ delimiter. Skip when adjacent char is a
    // letter/digit so we don't munge identifiers like patient_id.
    if (c === '*' || c === '_') {
      const close = text.indexOf(c, i + 1);
      const before = text[i - 1];
      const after = text[i + 1];
      const isWordBoundaryStart =
        before === undefined || /\W/.test(before);
      const isContentStart = after !== undefined && after !== c && !/\s/.test(after);
      if (close !== -1 && close > i + 1 && isWordBoundaryStart && isContentStart) {
        const innerBefore = text[close - 1];
        const innerAfter = text[close + 1];
        const isContentEnd = innerBefore !== undefined && !/\s/.test(innerBefore);
        const isWordBoundaryEnd = innerAfter === undefined || /\W/.test(innerAfter);
        if (isContentEnd && isWordBoundaryEnd) {
          pushPlain();
          const inner = text.slice(i + 1, close);
          runId += 1;
          out.push(
            createElement(
              'em',
              { key: `${keyPrefix}-i-${String(runId)}` },
              inlineMarkdownToNodes(inner, `${keyPrefix}-i-${String(runId)}-i`),
            ),
          );
          i = close + 1;
          continue;
        }
      }
    }
    // Inline code with backticks.
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1 && close > i + 1) {
        pushPlain();
        const inner = text.slice(i + 1, close);
        runId += 1;
        out.push(
          createElement(
            'code',
            { key: `${keyPrefix}-c-${String(runId)}` },
            inner,
          ),
        );
        i = close + 1;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  pushPlain();
  return out;
}

/**
 * Split a long assistant text run into paragraphs. Recognized splits:
 *
 *   - explicit blank line (`\n\n`)
 *   - whitespace before a `**Headline:**` token — the synthesizer
 *     emits headline-bolded sections inline, no newlines, and we want
 *     each one on its own row
 *   - a leading `(N)` or `N. ` marker that didn't already start a line
 *     (numbered follow-up items)
 *
 * The result is a list of paragraph strings; downstream callers feed
 * each paragraph through `inlineMarkdownToNodes`.
 */
export function splitParagraphs(text: string): string[] {
  if (text.trim() === '') return [];
  // Insert an explicit paragraph break before bolded headlines that
  // appear mid-text. We anchor on `**X:**` (the synthesizer's section
  // marker shape) rather than every `**...**` so inline emphasis
  // isn't yanked onto its own row.
  let normalized = text.replace(/\s+(?=\*\*[^*\n]{1,80}:\*\*)/g, '\n\n');
  // Numbered-list items inline (e.g. "follow-ups: (1) ... (2) ...").
  normalized = normalized.replace(/(?<=\S)\s+(?=\(\d+\)\s)/g, '\n');
  // Unicode bullet markers occasionally slip through; keep them on
  // their own line too.
  normalized = normalized.replace(/(?<=\S)\s+(?=[•·]\s)/g, '\n');
  return normalized
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, '').trim())
    .filter((p) => p.length > 0);
}

/**
 * Convenience wrapper: render a plain text run as a list of paragraph
 * `<p>` (or `<li>` for `- `-prefixed lines) elements with inline
 * markdown applied to each. Used for assistant text that the panel
 * wants to lay out block-by-block but where the surrounding container
 * is already a flow root (i.e. no extra <div> wrapper).
 */
export function renderMarkdownBlocks(text: string, keyPrefix: string): ReactNode[] {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return [];
  return paragraphs.map((p, idx) => {
    // Render a sequence of "- foo" lines as a <ul>, otherwise a <p>.
    const lines = p.split(/\n+/);
    if (lines.every((ln) => /^\s*-\s+/.test(ln))) {
      return createElement(
        'ul',
        { key: `${keyPrefix}-p${String(idx)}`, className: 'copilot-md-list' },
        lines.map((ln, li) =>
          createElement(
            'li',
            { key: `${keyPrefix}-p${String(idx)}-li${String(li)}` },
            inlineMarkdownToNodes(ln.replace(/^\s*-\s+/, ''), `${keyPrefix}-p${String(idx)}-li${String(li)}`),
          ),
        ),
      );
    }
    return createElement(
      'p',
      { key: `${keyPrefix}-p${String(idx)}`, className: 'copilot-md-paragraph' },
      inlineMarkdownToNodes(p, `${keyPrefix}-p${String(idx)}`),
    );
  });
}

/**
 * Render `text` as inline markdown wrapped in a single React fragment.
 * Used when the panel needs to keep the run inline with surrounding
 * chips (segments composed of "<text> <chip> <text> <chip>" runs).
 * Paragraph splitting happens at the segment-list level instead.
 */
export function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode {
  return createElement(Fragment, null, inlineMarkdownToNodes(text, keyPrefix));
}
