/**
 * Shared scaffolding for UC1 eval cases. Every case loads a fixture
 * snapshot, drives the briefing graph with a stub `Synthesizer` that
 * emits a deterministic ledger from the snapshot, and asserts the
 * verifier's terminal state.
 *
 * The synthesizer stub is intentionally faithful: it mirrors what the
 * real Anthropic-backed synthesizer is *supposed* to produce given a
 * snapshot — one claim per fact present in the snapshot, every claim
 * carrying the source reference of its backing record. Adversarial
 * cases compose this baseline (`buildFaithfulSynth`) and inject the
 * specific failure mode they're testing.
 */

import { vi } from 'vitest';

import type { Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type {
    Claim,
    ClaimLedger,
    DraftBriefing,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import type { ChartSnapshot } from '../../../src/snapshot/types.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';

export { loadFixture } from '../../fixtures/load.js';

export const baseEnvelope = (snapshot: ChartSnapshot): RequestEnvelope => ({
    conversationId: `conv-${snapshot.patient.uuid}`,
    requestId: `req-${snapshot.patient.uuid}`,
    siteId: 'default',
    actor: { userId: 'eval-actor', fhirUser: 'https://emr/Practitioner/eval-actor' },
    patient: { pid: snapshot.patient.pid, uuid: snapshot.patient.uuid },
    task: 'default_briefing',
});

/**
 * Stub `SnapshotClient` that returns the supplied chart for every call.
 * Cross-patient tests substitute this with one that throws or returns
 * a different chart.
 */
export const buildClient = (snapshot: ChartSnapshot): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(snapshot)),
});

const claimsFromSnapshot = (snapshot: ChartSnapshot): readonly Claim[] => {
    const claims: Claim[] = [];

    let id = 1;
    const nextId = (): string => {
        const out = `cl-${String(id)}`;
        id += 1;
        return out;
    };

    claims.push({
        id: nextId(),
        text: `Patient ${snapshot.patient.displayName} (DOB ${snapshot.patient.dateOfBirth ?? 'unknown'})`,
        category: 'identity',
        sourceReferences: [snapshot.patient.source],
        safetyCritical: false,
    });

    if (snapshot.appointment !== null) {
        const appt = snapshot.appointment;
        const reason = appt.reason ?? appt.type ?? 'visit';
        claims.push({
            id: nextId(),
            text: `Appointment today at ${appt.startAt} for ${reason}`,
            category: 'appointment',
            sourceReferences: [appt.source],
            safetyCritical: false,
        });
    }

    for (const dx of snapshot.diagnoses) {
        claims.push({
            id: nextId(),
            text: `Active diagnosis: ${dx.label} (${dx.code})`,
            category: 'diagnosis',
            sourceReferences: [dx.source],
            safetyCritical: false,
        });
    }

    for (const med of snapshot.medications) {
        claims.push({
            id: nextId(),
            text: `Active medication: ${med.name} ${med.dose ?? ''}`.trim(),
            category: 'medication',
            sourceReferences: [med.source],
            safetyCritical: true,
        });
    }

    for (const al of snapshot.allergies) {
        claims.push({
            id: nextId(),
            text: `Allergy: ${al.substance}`,
            category: 'allergy',
            sourceReferences: [al.source],
            safetyCritical: true,
        });
    }

    for (const lab of snapshot.labs) {
        claims.push({
            id: nextId(),
            text: `${lab.analyte}: ${lab.value} ${lab.unit ?? ''}`.trim(),
            category: 'lab',
            sourceReferences: [lab.source],
            safetyCritical: false,
        });
    }

    for (const enc of snapshot.encounters) {
        const date = enc.encounterDate ?? 'unknown date';
        const type = enc.type ?? 'visit';
        claims.push({
            id: nextId(),
            text: `Encounter on ${date} (${type})`,
            category: 'encounter',
            sourceReferences: [enc.source],
            safetyCritical: false,
        });
    }

    return claims;
};

/**
 * Stub synthesizer that emits a fully-grounded claim ledger from the
 * snapshot it receives. The draft is a single segment that name-checks
 * every claim id so the verifier exercises every branch. A real model
 * would emit prose; the test only cares about the gate.
 *
 * Returns the underlying `vi.fn` so callers can assert the call count
 * (cross-patient case checks "0 tokens spent" by asserting 0 calls).
 */
export interface FaithfulSynth {
    readonly synth: Synthesizer;
    readonly mock: ReturnType<typeof vi.fn>;
}

export const buildFaithfulSynth = (): FaithfulSynth => {
    const mock = vi.fn(({ snapshot }: { snapshot: ChartSnapshot }) => {
        const claims = claimsFromSnapshot(snapshot);
        const ledger: ClaimLedger = { claims };
        const draft: DraftBriefing = {
            segments: claims.map((c) => ({ text: c.text, claimIds: [c.id] })),
        };
        return Promise.resolve({ draft, ledger });
    });
    return { synth: mock as unknown as Synthesizer, mock };
};
