import { describe, expect, it } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type { Allergy, Prescription } from '../../../src/snapshot/types.js';
import type { BriefingSnapshot, Gap } from '../../../src/graph/types.js';
import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_PRESCRIPTIONS_UNAVAILABLE,
    verifyLedger,
} from '../../../src/verify/verifier.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildClient, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §3.6 fail-closed cases. ARCHITECTURE.md §"Safety Rules" pins the
 * contract: if allergies or medications can't be retrieved, the
 * briefing must not surface medication content. The verifier owns
 * this — `BriefingSnapshot` declares allergies/medications as
 * non-Gap arrays today (Retrieve fails the whole graph if the tool
 * errors), but the verifier treats a Gap defensively for forward-compat
 * with a §3.2 widening that lets specific safety categories degrade
 * to a Gap shape without failing the whole graph.
 *
 * We exercise that defense directly through `verifyLedger` rather than
 * forcing the runtime through a contradicting BriefingSnapshot via a
 * cast. That keeps the test asserting the documented behavior at the
 * gate, not at the type system.
 */

const buildGapSnapshot = (
    base: BriefingSnapshot,
    overrides: { prescriptions?: Gap; allergies?: Gap },
): BriefingSnapshot => {
    const out: {
        patient: BriefingSnapshot['patient'];
        appointment: BriefingSnapshot['appointment'];
        diagnoses: BriefingSnapshot['diagnoses'];
        prescriptions: readonly Prescription[] | Gap;
        allergies: readonly Allergy[] | Gap;
        labs: BriefingSnapshot['labs'];
        encounters: BriefingSnapshot['encounters'];
        labHistory: BriefingSnapshot['labHistory'];
    } = {
        patient: base.patient,
        appointment: base.appointment,
        diagnoses: base.diagnoses,
        prescriptions: overrides.prescriptions ?? base.prescriptions,
        allergies: overrides.allergies ?? base.allergies,
        labs: base.labs,
        encounters: base.encounters,
        labHistory: base.labHistory,
    };
    return out as BriefingSnapshot;
};

describe('UC1 fail-closed — missing allergies', () => {
    it('verifier surfaces the allergies-unavailable hard stop and rejects medication claims', async () => {
        const snapshot = loadFixture('diabetic');
        const gapped = buildGapSnapshot(snapshot, {
            allergies: { kind: 'gap', reason: 'allergies-fetch-failed', message: 'allergies unavailable' },
        });

        // The synthesizer built a ledger from the intact snapshot before
        // Retrieve discovered allergies were missing. The verifier must
        // drop every medication claim because the safety pre-condition
        // isn't met.
        const { synth } = buildFaithfulSynth();
        const { ledger } = await synth({ snapshot, envelope: baseEnvelope(snapshot) });
        const verified = verifyLedger(gapped, ledger);

        expect(verified.passed).toBe(false);
        expect(verified.safetyHardStops).toContain(HARD_STOP_ALLERGIES_UNAVAILABLE);
        const rejectedMedications = verified.rejected.filter(
            (rej) => rej.claim.category === 'prescription',
        );
        expect(rejectedMedications.length).toBeGreaterThan(0);
        expect(
            rejectedMedications.every((rej) => rej.reason === 'safety-critical-data-unavailable'),
        ).toBe(true);
    });
});

describe('UC1 fail-closed — missing medications', () => {
    it('verifier surfaces the medications-unavailable hard stop and rejects every medication claim', async () => {
        const snapshot = loadFixture('diabetic_uncontrolled');
        const gapped = buildGapSnapshot(snapshot, {
            prescriptions: { kind: 'gap', reason: 'medications-fetch-failed', message: 'medications unavailable' },
        });

        const { synth } = buildFaithfulSynth();
        const { ledger } = await synth({ snapshot, envelope: baseEnvelope(snapshot) });
        const verified = verifyLedger(gapped, ledger);

        expect(verified.passed).toBe(false);
        expect(verified.safetyHardStops).toContain(HARD_STOP_PRESCRIPTIONS_UNAVAILABLE);
        const accepted = verified.accepted;
        expect(accepted.find((c) => c.category === 'prescription')).toBeUndefined();
    });
});

describe('UC1 fail-closed — graph wires the gate', () => {
    /*
     * A complementary positive: the briefing graph end-to-end with the
     * intact snapshot reaches `passed: true`, so the negative cases
     * above prove behavior change — not a constant `passed: false`.
     */
    it('intact snapshot through the graph passes', async () => {
        const snapshot = loadFixture('diabetic');
        const client = buildClient(snapshot);
        const { synth } = buildFaithfulSynth();
        const graph = createBriefingGraph({
            retrieve: { client, token: 'eval-token', siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });
        const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });
        expect(out.verified?.passed).toBe(true);
    });
});
