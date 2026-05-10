/**
 * Locate a citation `quote` inside an extracted docx text body and
 * return the `[start, end]` character span in the original text.
 *
 * Why we search instead of trusting offsets: the agent stores
 * `bbox = [charStart, charEnd, 0, 0]` for docx (referral letter)
 * citations, where the first two ints are character offsets into
 * the docx-walker output. The model hallucinates those offsets —
 * they are usually wrong by tens or hundreds of characters, which
 * lands the highlight on unrelated prose. The `quote` string is
 * reliably correct (the model copies it verbatim from the document
 * body), so the renderer locates the highlight by string search
 * instead.
 *
 * Two lookup tiers:
 *
 *   1. Exact substring of the trimmed quote in the body.
 *   2. Whitespace-collapsed search. The docx walker emits `\n`
 *      between paragraphs and a literal space for `<w:tab/>`; the
 *      model sometimes squashes those to a single space in the
 *      quote. Build a collapsed copy of both sides + a parallel
 *      origin-index array, find the match in collapsed space, then
 *      map back to original-text indices.
 *
 * Returns `null` when both tiers miss; the renderer drops the
 * highlight rather than placing it incorrectly.
 */
export function findQuoteSpanInText(
    text: string,
    quote: string | null,
): [number, number] | null {
    if (quote === null) return null;
    const trimmed = quote.trim();
    if (trimmed.length === 0) return null;

    const exactIdx = text.indexOf(trimmed);
    if (exactIdx >= 0) return [exactIdx, exactIdx + trimmed.length];

    const collapsedChars: string[] = [];
    const originIdx: number[] = [];
    let lastWasWs = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i] ?? '';
        if (/\s/u.test(ch)) {
            if (lastWasWs) continue;
            if (collapsedChars.length === 0) {
                // Drop leading whitespace.
                lastWasWs = true;
                continue;
            }
            collapsedChars.push(' ');
            originIdx.push(i);
            lastWasWs = true;
        } else {
            collapsedChars.push(ch);
            originIdx.push(i);
            lastWasWs = false;
        }
    }
    // Drop trailing whitespace from the collapsed view.
    while (
        collapsedChars.length > 0 &&
        collapsedChars[collapsedChars.length - 1] === ' '
    ) {
        collapsedChars.pop();
        originIdx.pop();
    }
    const collapsedText = collapsedChars.join('');
    const collapsedQuote = trimmed.replace(/\s+/gu, ' ');
    const collapsedIdx = collapsedText.indexOf(collapsedQuote);
    if (collapsedIdx < 0) return null;
    const startOrigin = originIdx[collapsedIdx];
    const endOriginInclusive = originIdx[collapsedIdx + collapsedQuote.length - 1];
    if (startOrigin === undefined || endOriginInclusive === undefined) return null;
    return [startOrigin, endOriginInclusive + 1];
}
