/**
 * §B.10 lab-PDF eval cases (8). Each case asserts:
 *   - status === 'persisted'
 *   - schema-valid extraction (the pipeline already ran schemaValidate;
 *     we re-confirm by checking the persisted artifact has results)
 *   - every cited field carries bbox + page + quote (`hasCitations`)
 *   - no patient-mismatch refuse (chart and document patient agree)
 *
 * The multi-panel case additionally asserts results.length >= 4 so a
 * future regression that drops cross-panel rows surfaces here.
 */

import { describe, expect, it } from 'vitest';

import { runDocumentExtractionCase } from '../../../runners/documentExtractionTarget.js';
import { entriesByCaseKinds, entryByCaseId } from '../_helpers.js';

describe('§B.10 lab-pdf cases', () => {
    it('all 8 lab-pdf entries persist with citations', async () => {
        const entries = await entriesByCaseKinds([
            'lab-pdf-clean',
            'lab-pdf-multi-panel',
            'lab-pdf-low-quality',
            'lab-pdf-fax-packet',
        ]);
        expect(entries.length).toBe(8);

        for (const entry of entries) {
            const verdict = await runDocumentExtractionCase(entry);
            expect(
                verdict.status,
                `case ${entry.id} expected persisted, got ${verdict.status} with code=${verdict.errorCode ?? 'null'}`,
            ).toBe('persisted');
            expect(
                verdict.errorCode,
                `case ${entry.id} should have no error code on success`,
            ).toBeNull();
            expect(verdict.hasCitations, `case ${entry.id} citation invariant`).toBe(true);
            expect(
                verdict.insertedArtifact,
                `case ${entry.id} Tier-2 row should be inserted`,
            ).not.toBeNull();
            expect(verdict.insertedArtifact?.docType).toBe('lab_pdf');
            expect(verdict.minConfidence).toBeGreaterThan(0.7);
        }
    });

    it('multi-panel lipid case surfaces >=4 result rows (cross-panel coverage)', async () => {
        const entry = await entryByCaseId('lab-chen-lipid-panel');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        expect(verdict.resultRowCount).toBeGreaterThanOrEqual(4);
    });

    it('low-quality fax case still survives extraction (resultRowCount > 0)', async () => {
        const entry = await entryByCaseId('lab-kowalski-fax-packet');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        expect(verdict.resultRowCount).toBeGreaterThan(0);
    });

    it('image-passthrough cases skip transient duplicates (no transient rasterization)', async () => {
        const entry = await entryByCaseId('lab-reyes-hba1c-image');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        // Image-passthrough cases don't write transient PNGs - the
        // canonical key itself is the single page. The cleanup node's
        // delete pass thus leaves the canonical key alone (it deletes
        // only keys under `transient/...`).
        const transientDeleted = verdict.deletedTransientKeys.filter((k) =>
            k.startsWith('transient/'),
        );
        expect(transientDeleted).toHaveLength(0);
    });
});
