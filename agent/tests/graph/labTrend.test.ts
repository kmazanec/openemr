import { describe, expect, it, vi } from 'vitest';

import { createRetrieveChart, UC2_LAB_HISTORY_LOOKBACK_DAYS } from '../../src/graph/nodes/retrieveChart.js';
import type { LabHistoryFetcher } from '../../src/graph/nodes/retrieveChart.js';
import type { BriefingState } from '../../src/graph/state.js';
import type {
    LabHistorySeries,
    RequestEnvelope,
} from '../../src/graph/types.js';
import type { LabHistoryResult } from '../../src/tools/getLabHistory.js';
import type { LabObservation } from '../../src/snapshot/types.js';
import type { ChartSnapshot } from '../../src/snapshot/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';

/**
 * §4.2 Retrieve fan-out for the UC2 lab-trend path.
 *
 * The graph's branching is envelope-driven (no conditional edges in
 * the LangGraph topology), so the test surface is Retrieve. We assert:
 *
 *   - Retrieve calls the lab-history fetcher only when the envelope
 *     carries `followUp.type === 'lab_trend'`.
 *   - Retrieve files the fetched series into `snapshot.labHistory`.
 *   - Retrieve files a Gap when the fetcher returns one (fail-open).
 *   - Retrieve files a programmer-error Gap when a `lab_trend`
 *     envelope arrives without a fetcher wired (defensive — the prod
 *     runner always wires one).
 *   - Non-UC2 turns leave `labHistory: null`.
 */

const FIELD_FOR_RECORD_TYPE: Record<string, string> = {
    Patient: 'patient.name',
    Appointment: 'appointment.start',
    Condition: 'condition.code',
    MedicationRequest: 'medication.name',
    AllergyIntolerance: 'allergy.substance',
    Observation: 'observation.value',
    Encounter: 'encounter.date',
    Task: 'task.description',
    MedicationStatement: 'medicationStatement.medication',
    DocumentReference: 'documentReference.text',
};

const sourceRef = (recordType: string, recordId: string) => ({
    source_type: 'chart' as const,
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const baseChart = (): ChartSnapshot => ({
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        ageYears: 58,
        source: sourceRef('Patient', '42'),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
});

const buildClient = (chart: ChartSnapshot): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(chart)),
});

const trendObservation = (recordId: string, value: string, observedAt: string): LabObservation => ({
    analyte: 'Hemoglobin A1c',
    value,
    unit: '%',
    referenceRange: '4.0-5.6',
    abnormalFlag: 'H',
    observedAt,
    source: sourceRef('Observation', recordId),
});

const baseBriefingEnvelope = (): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
});

const labTrendEnvelope = (analyte = 'Hemoglobin A1c'): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'follow_up',
    followUp: { type: 'lab_trend', analyte },
});

const stateFor = (envelope: RequestEnvelope): BriefingState => ({
    envelope,
    priorTurnContext: { turns: [] },
    snapshot: null,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 0,
    retrieveChartArgs: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false,
});

describe('Retrieve — UC2 lab_trend fan-out', () => {
    it('calls the lab-history fetcher when followUp.type === lab_trend', async () => {
        const observations = [
            trendObservation('lab-1', '7.2', '2024-04-15'),
            trendObservation('lab-2', '8.1', '2025-04-15'),
            trendObservation('lab-3', '9.4', '2026-04-15'),
        ];
        const okResult: LabHistoryResult = { kind: 'ok', labs: observations };
        const fetchLabHistory = vi.fn(() => Promise.resolve(okResult)) as unknown as LabHistoryFetcher;

        const node = createRetrieveChart({
            client: buildClient(baseChart()),
            token: 'tok',
            siteId: 'default',
            fetchLabHistory,
        });
        const update = await node(stateFor(labTrendEnvelope()));

        expect(fetchLabHistory).toHaveBeenCalledTimes(1);
        const call = (fetchLabHistory as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
            analyte: string;
            lookbackDays: number;
            pid: number;
            siteId: string;
            token: string;
        };
        expect(call.analyte).toBe('Hemoglobin A1c');
        expect(call.lookbackDays).toBe(UC2_LAB_HISTORY_LOOKBACK_DAYS);
        expect(call.pid).toBe(42);
        expect(call.siteId).toBe('default');
        expect(call.token).toBe('tok');

        expect(update.snapshot?.labHistory).not.toBeNull();
        const series = update.snapshot?.labHistory as LabHistorySeries;
        expect(series.analyte).toBe('Hemoglobin A1c');
        expect(series.observations).toHaveLength(3);
    });

    it('does NOT call the fetcher for default_briefing turns', async () => {
        const fetchLabHistory = vi.fn(() => Promise.reject(new Error('should not be called'))) as
            unknown as LabHistoryFetcher;

        const node = createRetrieveChart({
            client: buildClient(baseChart()),
            token: 'tok',
            siteId: 'default',
            fetchLabHistory,
        });
        const update = await node(stateFor(baseBriefingEnvelope()));

        expect(fetchLabHistory).not.toHaveBeenCalled();
        expect(update.snapshot?.labHistory).toBeNull();
    });

    it('files a Gap into snapshot.labHistory when the fetcher returns a gap', async () => {
        const gap: LabHistoryResult = {
            kind: 'gap',
            reason: 'endpoint-unavailable',
            message: 'Lab history are not available right now (status 503).',
        };
        const fetchLabHistory = vi.fn(() => Promise.resolve(gap)) as unknown as LabHistoryFetcher;

        const node = createRetrieveChart({
            client: buildClient(baseChart()),
            token: 'tok',
            siteId: 'default',
            fetchLabHistory,
        });
        const update = await node(stateFor(labTrendEnvelope()));

        expect(update.snapshot?.labHistory).toEqual({
            kind: 'gap',
            reason: 'endpoint-unavailable',
            message: 'Lab history are not available right now (status 503).',
        });
    });

    it('files a programmer-error gap when a lab_trend envelope arrives with no fetcher wired', async () => {
        // Defensive: the production runner always wires the fetcher.
        // If a lab_trend envelope ever reaches Retrieve without one,
        // we file a typed gap rather than throwing — the synthesizer's
        // UC2 prompt then renders "history unavailable" and the
        // verifier rejects any trend assertion.
        const node = createRetrieveChart({
            client: buildClient(baseChart()),
            token: 'tok',
            siteId: 'default',
        });
        const update = await node(stateFor(labTrendEnvelope()));

        expect(update.snapshot?.labHistory).toEqual({
            kind: 'gap',
            reason: 'fetcher-unwired',
            message: 'Lab history is not available right now.',
        });
    });
});
