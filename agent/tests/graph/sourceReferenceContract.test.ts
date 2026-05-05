import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SourceReferenceSchema } from '../../src/graph/types.js';

/**
 * Cross-language contract test for the unified W2 `SourceReference`
 * shape. The fixture is committed at
 * `agent/tests/fixtures/contract/sourceReference.json`; the PHP-side
 * `SourceReferenceContractTest` reads the same file and asserts the
 * round-trip from the other direction.
 *
 * Per `feedback_compare_decoded_not_formatted`, structural equality
 * is asserted on `JSON.parse` output; do not compare formatted JSON
 * bytes — the repo's pretty-format-json hook would fight any
 * specific spacing this test pinned.
 *
 * If this test fails, either `SourceReferenceSchema` drifted from
 * `W2_ARCHITECTURE.md` §"Unified `SourceReference` shape", or the
 * fixture itself is malformed. Update both the TS schema and the
 * PHP `SourceReference` class together.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../fixtures/contract/sourceReference.json');

const SourceReferenceFixtureSchema = z.object({
    schema_version: z.string().min(1),
    examples: z.array(SourceReferenceSchema).min(3),
});

const loadFixture = (): unknown => {
    const raw = readFileSync(fixturePath, 'utf8');
    return JSON.parse(raw);
};

describe('SourceReference cross-language contract', () => {
    it('parses every example through the unified W2 schema', () => {
        const fixture = SourceReferenceFixtureSchema.parse(loadFixture());
        // Sanity: every source_type appears at least once so the
        // polymorphism rules are exercised both sides.
        const types = new Set(fixture.examples.map((ex) => ex.source_type));
        expect(types).toContain('chart');
        expect(types).toContain('extracted_document');
        expect(types).toContain('guideline');
    });

    it('round-trips through JSON without losing fields', () => {
        const original = loadFixture() as { examples: unknown[] };
        const parsed = SourceReferenceSchema.array().parse(original.examples);
        // Compare decoded structures, not formatted bytes
        // (`feedback_compare_decoded_not_formatted`). Re-encoding
        // and re-decoding should produce a structurally equal value.
        const reEncoded = JSON.parse(JSON.stringify(parsed));
        expect(reEncoded).toEqual(original.examples);
    });

    it('rejects a chart reference without locator.field', () => {
        const bad = {
            source_type: 'chart',
            source_id: 'Observation/abc',
            locator: {},
            quote: '7.4 %',
        };
        const result = SourceReferenceSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects an extracted_document reference without page or bbox', () => {
        const bad = {
            source_type: 'extracted_document',
            source_id: 'artifact-1',
            locator: { field: 'results[0].value' },
            quote: 'HbA1c 7.6 %',
        };
        const result = SourceReferenceSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects a guideline reference without section', () => {
        const bad = {
            source_type: 'guideline',
            source_id: 'uspstf-chunk-1',
            locator: {},
            quote: 'Recommendation text',
        };
        const result = SourceReferenceSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects a confidence outside [0,1]', () => {
        const bad = {
            source_type: 'extracted_document',
            source_id: 'artifact-2',
            locator: { page: 1, bbox: [1, 2, 3, 4] },
            quote: 'value',
            confidence: 1.4,
        };
        const result = SourceReferenceSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects a bbox that is not a 4-tuple', () => {
        const bad = {
            source_type: 'extracted_document',
            source_id: 'artifact-3',
            locator: { page: 1, bbox: [1, 2, 3] },
            quote: 'value',
        };
        const result = SourceReferenceSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects an empty quote', () => {
        const bad = {
            source_type: 'chart',
            source_id: 'Observation/abc',
            locator: { field: 'observation.value' },
            quote: '',
        };
        const result = SourceReferenceSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });
});
