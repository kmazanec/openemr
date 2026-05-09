/**
 * Referral-letter eval cases (3 entries, two clean + one wrong-patient).
 *
 * Asserts:
 *   - the two clean cases route through `persisted` with citations on
 *     every cited field;
 *   - each persisted artifact carries `docType === 'referral_letter'`;
 *   - the wrong-patient case routes through `failed/patient_mismatch`
 *     (the same shape as the lab-pdf adversarial-wrong-patient row),
 *     which is the patient-identifiers vs chart-demographics
 *     comparison's load-bearing safety property.
 *
 * The DOCX text path runs the real `extractDocxText` extractor on the
 * fixture bytes during `rasterize` (the per-MR gate stubs vision but
 * not rasterize). A regression in the ZIP/XML walk surfaces here as a
 * `rasterize_failed` error on these cases.
 */

import { describe, expect, it } from 'vitest';

import { runDocumentExtractionCase } from '../../../runners/documentExtractionTarget.js';
import { entriesByCaseKinds, entryByCaseId } from '../_helpers.js';

describe('referral-letter cases', () => {
    it('clean referrals persist with citations and the correct docType', async () => {
        const entries = await entriesByCaseKinds(['referral-letter-clean']);
        expect(entries.length).toBe(2);

        for (const entry of entries) {
            const verdict = await runDocumentExtractionCase(entry);
            expect(
                verdict.status,
                `case ${entry.id} expected persisted, got ${verdict.status} with code=${verdict.errorCode ?? 'null'}`,
            ).toBe('persisted');
            expect(verdict.hasCitations, `case ${entry.id} citation invariant`).toBe(true);
            expect(
                verdict.insertedArtifact?.docType,
                `case ${entry.id} doc type`,
            ).toBe('referral_letter');
        }
    });

    it('wrong-patient referral routes through patient_mismatch', async () => {
        const entry = await entryByCaseId('referral-wrong-patient');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('failed');
        expect(verdict.errorCode).toBe('patient_mismatch');
        // No artifact is inserted on the refuse path; deltas update is
        // also absent because emitDeltas short-circuits on `failed`.
        expect(verdict.insertedArtifact).toBeNull();
    });
});
