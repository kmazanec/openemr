/**
 * Lab-trend (UC2) case helpers.
 *
 * The deterministic `lab_trend` branch is gone — the supervisor now
 * routes free-text follow-ups via the synthesizer like any other
 * question. These helpers preserve the verifier-focused regression
 * coverage by composing a stubbed synthesizer + chart snapshot whose
 * `labs[]` carries the analyte history rows. The Vitest gate remains
 * deterministic-only; real-LLM coverage lives in the nightly
 * `experiment.ts` runner.
 */

import { vi } from 'vitest';

import type { Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type {
    BriefingSnapshot,
    Claim,
    ClaimLedger,
    DraftBriefing,
    LabHistorySeries,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import type { LabObservation } from '../../../src/snapshot/types.js';
import type { ChartSnapshot } from '../../../src/snapshot/types.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';

export { loadUc2Fixture } from '../../fixtures/load.js';
export type { Uc2Scenario } from '../../fixtures/load.js';

export const UC2_ANALYTE = 'Hemoglobin A1c';

/**
 * Build a free-text follow-up envelope asking the supervisor to trend
 * the analyte. The user's typed question is the only signal — there is
 * no typed `followUp` field anymore.
 */
export const trendEnvelope = (snapshot: BriefingSnapshot): RequestEnvelope => ({
    conversationId: `conv-${snapshot.patient.uuid}`,
    requestId: `req-${snapshot.patient.uuid}`,
    siteId: 'default',
    actor: { userId: 'eval-actor', fhirUser: 'https://emr/Practitioner/eval-actor' },
    patient: { pid: snapshot.patient.pid, uuid: snapshot.patient.uuid },
    task: 'follow_up',
    question: `How is ${UC2_ANALYTE} trending?`,
});

/**
 * Snapshot client that returns the bulk chart with the fixture's
 * lab-history observations folded into `labs[]`. retrieveChart no
 * longer auto-fetches lab history on a typed envelope; the trend
 * regression coverage now relies on those rows being present in the
 * standard `labs` slot the verifier already indexes.
 */
export const buildClient = (snapshot: BriefingSnapshot): SnapshotClient => {
    const baseLabs: readonly LabObservation[] = Array.isArray(snapshot.labs) ? snapshot.labs : [];
    const series = snapshot.labHistory;
    const historyLabs: readonly LabObservation[] =
        series !== null && !('kind' in series) ? series.observations : [];
    const seenIds = new Set<string>();
    const mergedLabs: LabObservation[] = [];
    for (const l of [...baseLabs, ...historyLabs]) {
        if (seenIds.has(l.source.source_id)) continue;
        seenIds.add(l.source.source_id);
        mergedLabs.push(l);
    }
    const chart: ChartSnapshot = {
        patient: snapshot.patient,
        appointment: snapshot.appointment,
        diagnoses: snapshot.diagnoses,
        prescriptions: snapshot.prescriptions,
        allergies: snapshot.allergies,
        labs: mergedLabs,
        encounters: Array.isArray(snapshot.encounters) ? snapshot.encounters : [],
        reminders: Array.isArray(snapshot.reminders) ? snapshot.reminders : [],
        medications: Array.isArray(snapshot.medications) ? snapshot.medications : [],
    };
    return {
        fetchSnapshot: vi.fn(() => Promise.resolve(chart)),
    };
};

/**
 * Stub synthesizer factory. The model's job here is to read the
 * snapshot's labs and produce a trend assertion; the verifier's job is
 * to check that every cited value matches its source row's
 * value/observedAt/unit. Cases compose this baseline with their own
 * `produceLedger` to inject specific failure modes.
 */
export const buildSynth = (
    produceLedger: (snapshot: BriefingSnapshot) => { draft: DraftBriefing; ledger: ClaimLedger },
): { synth: Synthesizer; mock: ReturnType<typeof vi.fn> } => {
    const mock = vi.fn(({ snapshot }: { snapshot: BriefingSnapshot }) =>
        Promise.resolve(produceLedger(snapshot)),
    );
    return { synth: mock, mock };
};

export const historySeries = (snapshot: BriefingSnapshot): LabHistorySeries | null => {
    const series = snapshot.labHistory;
    if (series === null) return null;
    if ('kind' in series) return null;
    return series;
};

/**
 * Build a single trend claim that cites every history row by its
 * recordId. Each ref is checked independently by the verifier; the
 * claim text must mention each row's value AND observedAt.
 */
export const trendClaim = (input: {
    readonly id: string;
    readonly text: string;
    readonly recordIds: readonly string[];
}): Claim => ({
    id: input.id,
    text: input.text,
    category: 'lab',
    sourceReferences: input.recordIds.map((rid) => ({
        source_type: 'chart' as const,
        source_id: rid,
        locator: { field: 'observation.value' },
        quote: rid,
    })),
    safetyCritical: false,
});
