import { describe, expect, it } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';
import { ARCHETYPES, type ArchetypeKey } from '../../fixtures/regenerate-archetypes.js';

import { baseEnvelope, buildClient, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §3.6 happy-path-per-archetype. For every archetype declared in
 * `bin/seed/PatientArchetype.php` (mirrored on the TS side in
 * `regenerate.ts`), assert that:
 *
 *   - the briefing graph runs to completion,
 *   - the verifier passes,
 *   - the ledger surfaces the archetype's pinned ground truth (e.g.
 *     Diabetic → E11.9 + metformin, Hypertensive → I10 + lisinopril),
 *   - and `formatted` carries no redacted segments.
 *
 * The synthesizer is a stub that emits a faithful ledger from the
 * snapshot. We are not asserting the *prose* a real model would
 * produce — that's a §6.1 LangSmith eval. We are asserting that
 * given a faithful synthesizer, the deterministic gate accepts every
 * claim. A regression to the verifier or the archetype contract
 * fails this.
 */

interface ArchetypeGroundTruth {
    readonly diagnosisCodes: readonly string[];
    readonly medicationNames: readonly string[];
}

const GROUND_TRUTH: Record<ArchetypeKey, ArchetypeGroundTruth> = {
    healthy_adult: { diagnosisCodes: [], medicationNames: [] },
    hypertensive: { diagnosisCodes: ['I10'], medicationNames: ['Lisinopril'] },
    diabetic: { diagnosisCodes: ['E11.9'], medicationNames: ['Metformin'] },
    diabetic_uncontrolled: {
        diagnosisCodes: ['E11.9'],
        medicationNames: ['Metformin', 'Lisinopril'],
    },
    complex_elderly: {
        diagnosisCodes: ['I10', 'E78.5', 'M19.90'],
        medicationNames: ['Lisinopril', 'Atorvastatin'],
    },
    recent_ed_visit: { diagnosisCodes: [], medicationNames: [] },
};

describe.each(ARCHETYPES)('UC1 happy path — %s', (archetype) => {
    it('verifier accepts every claim and formats the briefing without redaction', async () => {
        const snapshot = loadFixture(archetype);
        const client = buildClient(snapshot);
        const { synth } = buildFaithfulSynth();
        const graph = createBriefingGraph({
            retrieveChart: { client, token: 'eval-token', siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

        expect(out.verified).toBeDefined();
        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.rejected).toEqual([]);
        expect(out.verified?.safetyHardStops).toEqual([]);

        const accepted = out.verified?.accepted ?? [];
        const acceptedDxCodes = accepted
            .filter((c) => c.category === 'diagnosis')
            .flatMap((c) => GROUND_TRUTH[archetype].diagnosisCodes.filter((code) => c.text.includes(code)));
        const acceptedMedNames = accepted
            .filter((c) => c.category === 'prescription')
            .flatMap((c) => GROUND_TRUTH[archetype].medicationNames.filter((name) => c.text.includes(name)));

        expect(acceptedDxCodes).toEqual(expect.arrayContaining([...GROUND_TRUTH[archetype].diagnosisCodes]));
        expect(acceptedMedNames).toEqual(expect.arrayContaining([...GROUND_TRUTH[archetype].medicationNames]));

        // W2 SourceReference shape: every accepted claim's citations
        // must carry source_type='chart' for archetype fixtures (no
        // extracted_document or guideline sources land in UC1 paths).
        const acceptedSourceTypes = accepted.flatMap((c) =>
            c.sourceReferences.map((ref) => ref.source_type),
        );
        expect(acceptedSourceTypes.every((t) => t === 'chart')).toBe(true);

        const segments = out.formatted?.segments ?? [];
        expect(segments.length).toBeGreaterThan(0);
        expect(segments.every((s) => !s.redacted)).toBe(true);
        expect(out.formatted?.gaps).toEqual([]);
    });
});
