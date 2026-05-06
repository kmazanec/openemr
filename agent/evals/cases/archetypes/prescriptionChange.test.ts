import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type { Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type {
    SupervisorDecide,
    SupervisorDeps,
} from '../../../src/graph/nodes/supervisor.js';
import type { Claim, ClaimLedger, RequestEnvelope } from '../../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';
import { verifyLedger } from '../../../src/verify/verifier.js';

import { buildClient, loadFixture } from './_helpers.js';

/**
 * Medication-change drill-down regression coverage.
 *
 * The deterministic prescription-change branch is gone — a tapped chip
 * or typed question now flows as a free-text follow-up through the
 * supervisor + synthesizer. The verifier's prescription-change rule
 * still pins documented provenance (claim text must mention non-null
 * prescriber + indication when the source row carries them), so most
 * of this file is direct `verifyLedger` coverage. The remaining graph-
 * level case stubs the supervisor + synthesizer to confirm the same
 * rule fires when the claim flows through the full pipeline.
 */

const TOKEN = 'eval-token';

const followUpEnvelope = (snapshot: { patient: { pid: number; uuid: string } }): RequestEnvelope => ({
    conversationId: `conv-${snapshot.patient.uuid}`,
    requestId: `req-${snapshot.patient.uuid}`,
    siteId: 'default',
    actor: { userId: 'eval-actor', fhirUser: 'https://emr/Practitioner/eval-actor' },
    patient: { pid: snapshot.patient.pid, uuid: snapshot.patient.uuid },
    task: 'follow_up',
    question: 'Why was Lisinopril prescribed?',
});

/**
 * Stub supervisor that picks `synthesize` immediately. The supervisor
 * is the LLM-driven router in production; the eval gate's job is to
 * exercise the synthesize → verify path, not the router.
 */
const synthesizeNowSupervisor: SupervisorDeps = {
    decide: vi.fn<SupervisorDecide>(() =>
        Promise.resolve({
            handoff: 'synthesize',
            reason: 'free-text follow-up; chart context already loaded; synthesizing',
            narration: 'Drafting your answer.',
        }),
    ),
};

describe('medication change — verifier rule (documented prescriber + indication)', () => {
    it('lisinopril_recent_start: faithful claim citing every documented field is accepted', () => {
        const snapshot = loadFixture('lisinopril_recent_start');
        const lisinopril = snapshot.prescriptions.find((m) => m.name === 'Lisinopril');
        expect(lisinopril).toBeDefined();
        if (lisinopril === undefined) return;
        expect(lisinopril.prescriber).not.toBeNull();
        expect(lisinopril.indication).not.toBeNull();

        const claim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Dr. Patel for new-onset hypertension.',
            category: 'prescription_change',
            sourceReferences: [lisinopril.source],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [claim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(true);
        expect(out.accepted).toHaveLength(1);
        expect(out.rejected).toHaveLength(0);
    });

    it('med_no_indication: claim text omits "for" when source indication is null', () => {
        const snapshot = loadFixture('med_no_indication');
        const lisinopril = snapshot.prescriptions.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.indication).toBeNull();
        if (lisinopril === undefined) return;

        const claim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Dr. Patel.',
            category: 'prescription_change',
            sourceReferences: [lisinopril.source],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [claim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(true);
        expect(out.accepted).toHaveLength(1);
    });

    it('adversarial: rejects a claim that omits a non-null prescriber', () => {
        const snapshot = loadFixture('lisinopril_recent_start');
        const lisinopril = snapshot.prescriptions.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.prescriber).not.toBeNull();
        if (lisinopril === undefined) return;

        const fabricatedClaim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20 for new-onset hypertension.',
            category: 'prescription_change',
            sourceReferences: [lisinopril.source],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [fabricatedClaim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(false);
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected).toHaveLength(1);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('adversarial: rejects a claim that omits a non-null indication', () => {
        const snapshot = loadFixture('lisinopril_recent_start');
        const lisinopril = snapshot.prescriptions.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.indication).not.toBeNull();
        if (lisinopril === undefined) return;

        const fabricatedClaim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Dr. Patel.',
            category: 'prescription_change',
            sourceReferences: [lisinopril.source],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [fabricatedClaim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(false);
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('adversarial: rejects a claim citing a MedicationRequest not in the snapshot', () => {
        const snapshot = loadFixture('lisinopril_recent_start');

        const fabricatedClaim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Dr. Patel for new-onset hypertension.',
            category: 'prescription_change',
            sourceReferences: [{
                source_type: 'chart',
                source_id: '999999',
                locator: { field: 'medication.name' },
                quote: '999999',
            }],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [fabricatedClaim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(false);
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('med_unknown_prescriber: claim text omits prescriber when source is null', () => {
        const snapshot = loadFixture('med_unknown_prescriber');
        const lisinopril = snapshot.prescriptions.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.prescriber).toBeNull();
        if (lisinopril === undefined) return;

        const claim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20 for new-onset hypertension.',
            category: 'prescription_change',
            sourceReferences: [lisinopril.source],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [claim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(true);
        expect(out.accepted).toHaveLength(1);
    });
});

describe('medication change — graph integration via free-text follow-up', () => {
    it('routes a "Why was X prescribed?" question through synthesize and accepts a faithful claim', async () => {
        const snapshot = loadFixture('lisinopril_recent_start');
        const lisinopril = snapshot.prescriptions.find((m) => m.name === 'Lisinopril');
        expect(lisinopril).toBeDefined();
        if (lisinopril === undefined) return;

        const ledgerClaim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Dr. Patel for new-onset hypertension.',
            category: 'prescription_change',
            sourceReferences: [lisinopril.source],
            safetyCritical: true,
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [
                        { text: ledgerClaim.text, claimIds: ['mc-1'] },
                    ],
                },
                ledger: { claims: [ledgerClaim] },
            }),
        );

        const graph = createBriefingGraph({
            retrieveChart: { client: buildClient(snapshot), token: TOKEN, siteId: 'default' },
            supervisor: synthesizeNowSupervisor,
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: followUpEnvelope(snapshot) });

        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.accepted[0]?.category).toBe('prescription_change');

        const seg = out.formatted?.segments[0];
        expect(seg?.redacted).toBe(false);
        expect(seg?.text).toContain('Lisinopril');
        expect(seg?.text).toContain('Dr. Patel');
        expect(seg?.text).toContain('new-onset hypertension');
    });
});
