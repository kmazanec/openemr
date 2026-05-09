import { describe, expect, it } from 'vitest';

import { repairStringEncodedLedger } from '../../../src/graph/nodes/synthesize.js';

const validLedger = {
    claims: [
        {
            id: 'c-1',
            text: 'HbA1c was 7.0% on 2025-05-11.',
            category: 'lab' as const,
            sourceReferences: [
                {
                    source_type: 'chart' as const,
                    source_id: '1177',
                    locator: { field: 'observation.value' },
                    quote: '7.0',
                },
            ],
            safetyCritical: true,
        },
    ],
};

const validSegments = [
    { text: 'HbA1c was 7.0% on 2025-05-11.', claimIds: ['c-1'] },
];

const toolUseRaw = (input: unknown) => ({
    content: [
        {
            type: 'tool_use',
            id: 'toolu_test',
            name: 'briefing_with_claim_ledger',
            input,
        },
    ],
});

describe('repairStringEncodedLedger', () => {
    it('recovers when ledger is a JSON-encoded string with structurally valid contents', () => {
        const raw = toolUseRaw({
            segments: validSegments,
            ledger: JSON.stringify(validLedger),
        });
        const repaired = repairStringEncodedLedger(raw);
        expect(repaired).not.toBeNull();
        expect(repaired?.segments).toEqual(validSegments);
        expect(repaired?.ledger.claims[0]?.id).toBe('c-1');
    });

    it('returns null when the ledger string is itself malformed JSON', () => {
        // Replicates the production failure: model emitted ledger as a
        // string AND forgot to escape inner double quotes inside it.
        const raw = toolUseRaw({
            segments: validSegments,
            ledger: '{"claims": [{"text": "ADA "Standards of Care" guideline"}]}',
        });
        expect(repairStringEncodedLedger(raw)).toBeNull();
    });

    it('returns null when the decoded ledger does not match the schema', () => {
        const raw = toolUseRaw({
            segments: validSegments,
            ledger: JSON.stringify({ claims: [{ id: 'c-1' }] }),
        });
        expect(repairStringEncodedLedger(raw)).toBeNull();
    });

    it('returns null when ledger is already a structured object (nothing to repair)', () => {
        const raw = toolUseRaw({
            segments: validSegments,
            ledger: validLedger,
        });
        expect(repairStringEncodedLedger(raw)).toBeNull();
    });

    it('returns null when segments is missing or not an array', () => {
        const raw = toolUseRaw({
            ledger: JSON.stringify(validLedger),
        });
        expect(repairStringEncodedLedger(raw)).toBeNull();
    });

    it('returns null when raw has no tool_use block', () => {
        const raw = { content: [{ type: 'text', text: 'oops' }] };
        expect(repairStringEncodedLedger(raw)).toBeNull();
    });

    it('returns null for unstructured raw values', () => {
        expect(repairStringEncodedLedger(null)).toBeNull();
        expect(repairStringEncodedLedger(undefined)).toBeNull();
        expect(repairStringEncodedLedger('not an object')).toBeNull();
        expect(repairStringEncodedLedger({ content: 'not an array' })).toBeNull();
    });
});
