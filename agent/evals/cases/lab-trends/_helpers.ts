/**
 * §4.2 UC2 (lab/vitals trend) case helpers.
 *
 * Mirrors the §3.6 UC1 `_helpers.ts` shape but builds typed
 * `lab_trend` envelopes instead of `default_briefing`. The Vitest
 * gate is the deterministic-only layer — every case stubs the
 * synthesizer so the test asserts the verifier's behavior on a known
 * ledger, not the model's output. Real-LLM coverage lives in the
 * nightly `experiment.ts` runner.
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
import type { LabHistoryFetcher } from '../../../src/graph/nodes/retrieveChart.js';
import type { LabObservation } from '../../../src/snapshot/types.js';
import type { ChartSnapshot } from '../../../src/snapshot/types.js';
import type { SnapshotClient } from '../../../src/tools/snapshotClient.js';

export { loadUc2Fixture } from '../../fixtures/load.js';
export type { Uc2Scenario } from '../../fixtures/load.js';

export const UC2_ANALYTE = 'Hemoglobin A1c';

export const trendEnvelope = (snapshot: BriefingSnapshot): RequestEnvelope => ({
    conversationId: `conv-${snapshot.patient.uuid}`,
    requestId: `req-${snapshot.patient.uuid}`,
    siteId: 'default',
    actor: { userId: 'eval-actor', fhirUser: 'https://emr/Practitioner/eval-actor' },
    patient: { pid: snapshot.patient.pid, uuid: snapshot.patient.uuid },
    task: 'follow_up',
    followUp: { type: 'lab_trend', analyte: UC2_ANALYTE },
});

/**
 * UC2-specific snapshot client. Retrieve calls `loadChartSnapshot`
 * for the bulk snapshot in addition to the lab-history fetcher; this
 * stub returns the fixture's bulk fields stripped of the UC2-only
 * `labHistory` slot (the bulk endpoint never carries it).
 */
export const buildClient = (snapshot: BriefingSnapshot): SnapshotClient => {
    const chart: ChartSnapshot = {
        patient: snapshot.patient,
        appointment: snapshot.appointment,
        diagnoses: snapshot.diagnoses,
        prescriptions: snapshot.prescriptions,
        allergies: snapshot.allergies,
        labs: Array.isArray(snapshot.labs) ? snapshot.labs : ([] as readonly LabObservation[]),
        encounters: Array.isArray(snapshot.encounters) ? snapshot.encounters : [],
        reminders: Array.isArray(snapshot.reminders) ? snapshot.reminders : [],
        medications: Array.isArray(snapshot.medications) ? snapshot.medications : [],
    };
    return {
        fetchSnapshot: vi.fn(() => Promise.resolve(chart)),
    };
};

/**
 * Build a `LabHistoryFetcher` stub that returns the fixture's
 * `labHistory.observations` (or an empty list if the fixture carries
 * no history). Tests that want to drive a fail-open path (e.g.
 * "endpoint unavailable") build their own fetcher instead.
 */
export const buildLabHistoryFetcher = (snapshot: BriefingSnapshot): LabHistoryFetcher => {
    const series = snapshot.labHistory;
    const observations: readonly LabObservation[] =
        series !== null && !('kind' in series) ? series.observations : [];
    return () =>
        Promise.resolve({
            kind: 'ok' as const,
            labs: observations,
        });
};

/**
 * Stub synthesizer factory. The model's job in UC2 is to read
 * `snapshot.labHistory.observations` and produce a trend assertion;
 * the verifier's job is to check that every cited value matches its
 * source row's value/observedAt/unit. Cases compose this baseline
 * with their own `produceLedger` to inject specific failure modes.
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
 * recordId. Each ref is checked independently by the §4.2 verifier
 * pass; the claim text must mention each row's value AND observedAt.
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
