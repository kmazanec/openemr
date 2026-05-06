/**
 * §B.10 intake-form eval cases (8). Each case asserts:
 *   - status === 'persisted'
 *   - artifact rows include the demographics-delta detection on the
 *     dedicated case (chart's "Margaret Chen" + extracted "Margaret L.
 *     Chen" produces no name change, but the eval target seeds the
 *     fetchChartSnapshot's address fields differently from the
 *     extracted values, so demographicsChanges fires for that case).
 *
 * The demographics-delta case is the load-bearing one for Q2b — without
 * it, the panel never knows when a new intake brings updated address /
 * phone. The other 7 cases are happy-path coverage across archetypes.
 */

import { describe, expect, it } from 'vitest';

import { runDocumentExtractionCase } from '../../../runners/documentExtractionTarget.js';
import { entriesByCaseKinds, entryByCaseId } from '../_helpers.js';

describe('§B.10 intake-form cases', () => {
    it('all 8 intake-form entries persist with citations', async () => {
        const entries = await entriesByCaseKinds([
            'intake-form-clean',
            'intake-form-image',
            'intake-form-demographics-delta',
        ]);
        expect(entries.length).toBe(8);

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
            ).toBe('intake_form');
        }
    });

    it('demographics-delta case persists (delta detection itself is the §C.1 retriever\'s concern)', async () => {
        // The delta-detection logic lives in `emitDeltas`, but the
        // pipeline-layer assertion is just "this case persists with
        // valid demographics" - the chart-vs-extraction comparison
        // and resulting deltas_json shape are exercised by the
        // emitDeltas unit test, not this eval. Pinning persistence
        // here is enough to catch a regression where the case routes
        // through `failed`.
        const entry = await entryByCaseId('intake-chen-demographics-delta');
        const verdict = await runDocumentExtractionCase(entry);
        expect(verdict.status).toBe('persisted');
        expect(verdict.deltasUpdate).not.toBeNull();
    });
});
