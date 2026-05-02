import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type { Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type { Claim, ClaimLedger, RequestEnvelope } from '../../../src/graph/types.js';
import type { AgentHttpClient } from '../../../src/tools/agentHttp.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';
import { verifyLedger } from '../../../src/verify/verifier.js';

import { buildClient, loadFixture } from './_helpers.js';

/**
 * §4.3 UC3 — medication-change drill-down per-MR Vitest gate.
 *
 * Per user direction these cases live alongside the UC1 cases under
 * `uc1/` rather than a sibling `uc3/` directory. The fixtures are
 * named (not in the UC1 sampling distribution) and loaded by name.
 *
 * Each case wires the graph with a stub `AgentHttpClient` that returns
 * the matching `medication_provenance` JSON for the fixture, builds a
 * follow-up envelope with the typed params, and asserts:
 *  - the synthesizer is NOT called (the branch bypasses it),
 *  - the verifier accepts exactly one `medication_change` claim,
 *  - the formatted segment text includes the expected fields and
 *    omits the absent ones.
 */

const TOKEN = 'eval-token';

const followUpEnvelope = (
    pid: number,
    uuid: string,
    medicationId: string,
): RequestEnvelope => ({
    conversationId: `conv-${uuid}`,
    requestId: `req-${uuid}`,
    siteId: 'default',
    actor: { userId: 'eval-actor', fhirUser: 'https://emr/Practitioner/eval-actor' },
    patient: { pid, uuid },
    task: 'follow_up',
    followUp: { type: 'medication_change', medicationId },
});

interface ProvenanceJson {
    readonly provenance: {
        readonly prescriptionId: number;
        readonly drugName: string;
        readonly prescriber: string | null;
        readonly prescribingDate: string | null;
        readonly indication: string | null;
        readonly doseAdjustments: readonly { readonly dose: string | null; readonly date: string | null }[];
    };
}

const buildProvenanceClient = (response: ProvenanceJson): AgentHttpClient => ({
    get: vi.fn(() => Promise.resolve<unknown>(response)),
});

describe('§4.3 UC3 medication change — eval cases (colocated under uc1/)', () => {
    it('lisinopril_recent_start: surfaces date + prescriber + indication from documented fields', async () => {
        const snapshot = loadFixture('lisinopril_recent_start');
        const lisinopril = snapshot.medications.find((m) => m.name === 'Lisinopril');
        expect(lisinopril).toBeDefined();
        if (lisinopril === undefined) return;

        const synth = vi.fn() as unknown as Synthesizer;
        const provenance: ProvenanceJson = {
            provenance: {
                prescriptionId: Number.parseInt(lisinopril.source.recordId, 10),
                drugName: 'Lisinopril',
                prescriber: 'Dr. Patel',
                prescribingDate: '2026-03-20',
                indication: 'new-onset hypertension',
                doseAdjustments: [{ dose: '10 mg', date: '2026-03-20' }],
            },
        };
        const graph = createBriefingGraph({
            retrieve: { client: buildClient(snapshot), token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            medChange: {
                client: buildProvenanceClient(provenance),
                token: TOKEN,
                siteId: 'default',
                openEmrBaseUrl: 'http://openemr',
            },
        });

        const envelope = followUpEnvelope(
            snapshot.patient.pid,
            snapshot.patient.uuid,
            `${lisinopril.source.recordType}:${lisinopril.source.recordId}`,
        );
        const out = await graph.invoke({ envelope });

        expect(synth).not.toHaveBeenCalled();
        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.accepted[0]?.category).toBe('medication_change');

        const seg = out.formatted?.segments[0];
        expect(seg?.redacted).toBe(false);
        expect(seg?.text).toContain('Lisinopril');
        expect(seg?.text).toContain('Dr. Patel');
        expect(seg?.text).toContain('new-onset hypertension');
        expect(seg?.text).toContain('2026-03-20');
    });

    it('med_no_indication: claim text omits "indication" when source is null', async () => {
        const snapshot = loadFixture('med_no_indication');
        const lisinopril = snapshot.medications.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.indication).toBeNull();
        if (lisinopril === undefined) return;

        const synth = vi.fn() as unknown as Synthesizer;
        const provenance: ProvenanceJson = {
            provenance: {
                prescriptionId: Number.parseInt(lisinopril.source.recordId, 10),
                drugName: 'Lisinopril',
                prescriber: 'Dr. Patel',
                prescribingDate: '2026-03-20',
                indication: null,
                doseAdjustments: [{ dose: '10 mg', date: '2026-03-20' }],
            },
        };
        const graph = createBriefingGraph({
            retrieve: { client: buildClient(snapshot), token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            medChange: {
                client: buildProvenanceClient(provenance),
                token: TOKEN,
                siteId: 'default',
                openEmrBaseUrl: 'http://openemr',
            },
        });

        const envelope = followUpEnvelope(
            snapshot.patient.pid,
            snapshot.patient.uuid,
            `${lisinopril.source.recordType}:${lisinopril.source.recordId}`,
        );
        const out = await graph.invoke({ envelope });

        expect(synth).not.toHaveBeenCalled();
        expect(out.verified?.passed).toBe(true);
        const seg = out.formatted?.segments[0];
        expect(seg?.redacted).toBe(false);
        expect(seg?.text).toContain('Lisinopril');
        expect(seg?.text).toContain('Dr. Patel');
        // No fabricated reason — verifier wouldn't have accepted the
        // claim if the branch invented one, but we also assert the
        // observable surface so a future renderer change is caught.
        expect(seg?.text).not.toMatch(/for \w/);
    });

    it('adversarial: rejects a claim that omits a non-null prescriber', () => {
        // The §4.3 verifier rule pins documented provenance: when the
        // source row carries a prescriber, the claim text MUST mention
        // it. A model that drops the prescriber for stylistic prose
        // looks plausible to the eye but breaks the documented-fields
        // promise — verify the gate refuses.
        const snapshot = loadFixture('lisinopril_recent_start');
        const lisinopril = snapshot.medications.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.prescriber).not.toBeNull();
        if (lisinopril === undefined) return;

        const fabricatedClaim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20 for new-onset hypertension.',
            category: 'medication_change',
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
        const lisinopril = snapshot.medications.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.indication).not.toBeNull();
        if (lisinopril === undefined) return;

        const fabricatedClaim: Claim = {
            id: 'mc-1',
            text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Dr. Patel.',
            category: 'medication_change',
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
            category: 'medication_change',
            sourceReferences: [{
                system: 'openemr',
                recordType: 'MedicationRequest',
                // Plausible-shape id that does not match any rx in the fixture.
                recordId: '999999',
                field: null,
                recordedAt: null,
            }],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [fabricatedClaim] };

        const out = verifyLedger(snapshot, ledger);

        expect(out.passed).toBe(false);
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('med_unknown_prescriber: claim text omits prescriber when source is null', async () => {
        const snapshot = loadFixture('med_unknown_prescriber');
        const lisinopril = snapshot.medications.find((m) => m.name === 'Lisinopril');
        expect(lisinopril?.prescriber).toBeNull();
        if (lisinopril === undefined) return;

        const synth = vi.fn() as unknown as Synthesizer;
        const provenance: ProvenanceJson = {
            provenance: {
                prescriptionId: Number.parseInt(lisinopril.source.recordId, 10),
                drugName: 'Lisinopril',
                prescriber: null,
                prescribingDate: '2026-03-20',
                indication: 'new-onset hypertension',
                doseAdjustments: [{ dose: '10 mg', date: '2026-03-20' }],
            },
        };
        const graph = createBriefingGraph({
            retrieve: { client: buildClient(snapshot), token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            medChange: {
                client: buildProvenanceClient(provenance),
                token: TOKEN,
                siteId: 'default',
                openEmrBaseUrl: 'http://openemr',
            },
        });

        const envelope = followUpEnvelope(
            snapshot.patient.pid,
            snapshot.patient.uuid,
            `${lisinopril.source.recordType}:${lisinopril.source.recordId}`,
        );
        const out = await graph.invoke({ envelope });

        expect(synth).not.toHaveBeenCalled();
        expect(out.verified?.passed).toBe(true);
        const seg = out.formatted?.segments[0];
        expect(seg?.redacted).toBe(false);
        expect(seg?.text).toContain('Lisinopril');
        expect(seg?.text).toContain('new-onset hypertension');
        expect(seg?.text).not.toContain('prescribed by');
    });
});
