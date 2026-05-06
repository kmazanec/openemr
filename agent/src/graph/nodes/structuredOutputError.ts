/**
 * Shared helper for the supervisor + synthesizer's structured-output
 * fallback path. When LangChain's `withStructuredOutput({ includeRaw:
 * true })` exhausts its parse-and-retry budget, `result.parsed` is
 * null. Both nodes throw on that condition; this helper composes a
 * typed error that carries a bounded excerpt of the raw model output
 * so the LangSmith trace (and the eval-suite failure card) has
 * enough signal to diagnose without re-running.
 */

const MAX_EXCERPT_LENGTH = 240;

const extractRawText = (raw: unknown): string => {
    const content = (raw as { content?: unknown } | null | undefined)?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const text = content
            .map((c) =>
                typeof c === 'object' && c !== null && 'text' in c
                    ? String((c as { text: unknown }).text)
                    : '',
            )
            .filter((t) => t.length > 0)
            .join(' ');
        return text.length > 0 ? text : JSON.stringify(content);
    }
    return raw === null || raw === undefined ? '' : JSON.stringify(raw);
};

export const structuredOutputParseError = (component: string, raw: unknown): Error => {
    const rawText = extractRawText(raw);
    const excerpt =
        rawText.length > MAX_EXCERPT_LENGTH ? `${rawText.slice(0, MAX_EXCERPT_LENGTH)}…` : rawText;
    return new Error(
        `${component}: structured output failed to parse${excerpt.length > 0 ? ` (raw: ${excerpt})` : ''}`,
    );
};
