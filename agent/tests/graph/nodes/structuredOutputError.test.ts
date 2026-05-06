import { describe, expect, it } from 'vitest';

import { structuredOutputParseError } from '../../../src/graph/nodes/structuredOutputError.js';

describe('structuredOutputParseError', () => {
    it('embeds a string-content excerpt verbatim when raw.content is a string', () => {
        const err = structuredOutputParseError('synthesizer', { content: 'I cannot comply.' });
        expect(err.message).toContain('synthesizer: structured output failed to parse');
        expect(err.message).toContain('I cannot comply.');
    });

    it('joins text blocks when raw.content is an array', () => {
        const err = structuredOutputParseError('supervisor', {
            content: [
                { type: 'text', text: 'Hmm, let me think.' },
                { type: 'text', text: 'Routing decision unclear.' },
            ],
        });
        expect(err.message).toContain('Hmm, let me think.');
        expect(err.message).toContain('Routing decision unclear.');
    });

    it('truncates excerpts longer than 240 chars with an ellipsis', () => {
        const longText = 'a'.repeat(500);
        const err = structuredOutputParseError('synthesizer', { content: longText });
        // The trailing ellipsis lives after the cap; the embedded
        // text should not exceed 240 chars + the ellipsis.
        expect(err.message).toContain(`${'a'.repeat(240)}…`);
        expect(err.message).not.toContain('a'.repeat(241));
    });

    it('falls back to JSON.stringify for unstructured raw shapes', () => {
        const err = structuredOutputParseError('synthesizer', { foo: 'bar', n: 42 });
        expect(err.message).toContain('"foo":"bar"');
        expect(err.message).toContain('"n":42');
    });

    it('omits the raw excerpt when raw is null/undefined', () => {
        const err1 = structuredOutputParseError('synthesizer', null);
        const err2 = structuredOutputParseError('synthesizer', undefined);
        expect(err1.message).toBe('synthesizer: structured output failed to parse');
        expect(err2.message).toBe('synthesizer: structured output failed to parse');
    });

    it('uses the component name as the message prefix', () => {
        const err = structuredOutputParseError('supervisor', { content: 'x' });
        expect(err.message.startsWith('supervisor: ')).toBe(true);
    });
});
