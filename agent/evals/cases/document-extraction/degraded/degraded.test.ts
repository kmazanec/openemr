/**
 * §B.10 degraded-input eval cases (6). Each case asserts the gate
 * the case targets:
 *
 *   - smudged: persists with low confidence_distribution (verifier-side
 *     rejection lives in Phase C, not here);
 *   - rotated: stub returns Zod-invalid; schemaValidate refuses;
 *   - blank: synthetic blank PDF; schema_invalid (no extractable content);
 *   - unrelated: synthetic invoice; schema_invalid (non-clinical);
 *   - partial-intake: persists with allergies absent (the fail-closed is
 *     a Phase C verifier rule);
 *   - ocr-bad: persists with low confidence (same shape as smudged).
 *
 * The test files for each manifest case assert the structural property
 * the case targets without re-asserting the rest of the pipeline. The
 * §B.7 e2e test already proves the wiring; this layer proves the
 * routing decisions.
 */

import { describe, expect, it } from 'vitest';

import { runDocumentExtractionCase } from '../../../runners/documentExtractionTarget.js';
import { entryByCaseId } from '../_helpers.js';

describe('§B.10 degraded-input cases', () => {
    it('degraded-smudged persists with low minimum confidence', async () => {
        const entry = await entryByCaseId('degraded-smudged');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        // Smudged uses confidenceMultiplier 0.5 in the stub, so the
        // minimum confidence drops below the 0.7 hard-stop threshold
        // the verifier applies in Phase C.
        expect(verdict.minConfidence).toBeLessThan(0.7);
    });

    it('degraded-rotated refuses with schema_invalid (no coercion)', async () => {
        const entry = await entryByCaseId('degraded-rotated');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('failed');
        expect(verdict.errorCode).toBe('schema_invalid');
        // No artifact written on a refused extraction.
        expect(verdict.insertedArtifact).toBeNull();
    });

    it('degraded-blank refuses with schema_invalid (synthetic PDF, no extractable content)', async () => {
        const entry = await entryByCaseId('degraded-blank');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('failed');
        expect(verdict.errorCode).toBe('schema_invalid');
    });

    it('degraded-unrelated refuses with schema_invalid (non-clinical PDF)', async () => {
        const entry = await entryByCaseId('degraded-unrelated');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('failed');
        expect(verdict.errorCode).toBe('schema_invalid');
    });

    it('degraded-partial-intake persists (allergy fail-closed is a Phase C concern)', async () => {
        const entry = await entryByCaseId('degraded-partial-intake');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        // The artifact carries allergies (an empty list), and the
        // verifier-side hard stop fires when the array is missing.
        // At the pipeline layer the artifact persists.
    });

    it('degraded-ocr-bad persists with low minimum confidence', async () => {
        const entry = await entryByCaseId('degraded-ocr-bad');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        expect(verdict.minConfidence).toBeLessThan(0.7);
    });
});
