/**
 * §B.6 patientMatch node tests.
 *
 * The three buckets the sub-phase calls out:
 *   1. Exact match (name 1.0 + DOB 1.0)        → 'matched', confidence_signal recorded.
 *   2. Off-by-one DOB (name 1.0 + DOB 0.5)     → 'matched', confidence_signal.patient_match_partial = true.
 *   3. Completely different name (name 0.0)    → 'failed/patient_mismatch'.
 *
 * Plus failure-isolation cases: upstream `failed` short-circuit, and a
 * snapshot-fetch error that fails the pipeline rather than passes a
 * silent zero-score through.
 */

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
    patientMatch,
    type PatientMatchDeps,
} from '../../src/pipeline/nodes/patientMatch.js';
import {
    initialPipelineState,
    type PipelineState,
} from '../../src/pipeline/state.js';
import type { Demographics } from '../../src/snapshot/types.js';

const noopLogger = pino({ level: 'silent' });

const chartChen: Demographics = {
    pid: 101,
    uuid: 'uuid-101',
    displayName: 'Margaret L. Chen',
    sex: 'Female',
    dateOfBirth: '1967-08-14',
    ageYears: 58,
    source: {
        source_type: 'chart',
        source_id: 'patient_data:101',
        locator: { field: 'patient_data' },
        quote: 'Margaret L. Chen DOB 1967-08-14',
    },
};

const labExtraction = (overrides?: {
    name?: string;
    dob?: string;
    sex?: string;
}): Record<string, unknown> => ({
    patient_demographics: {
        name: {
            value: overrides?.name ?? 'Margaret L. Chen',
            page: 1,
            bbox: [10, 10, 100, 20],
            quote: overrides?.name ?? 'CHEN, MARGARET',
            confidence: 0.95,
        },
        dob: {
            value: overrides?.dob ?? '1967-08-14',
            page: 1,
            bbox: [10, 30, 100, 20],
            quote: overrides?.dob ?? '1967-08-14',
            confidence: 0.9,
        },
        sex: {
            value: overrides?.sex ?? 'female',
            page: 1,
            bbox: [10, 50, 100, 20],
            quote: overrides?.sex ?? 'F',
            confidence: 0.9,
        },
    },
    results: [
        {
            analyte_name: 'HbA1c',
            value: '7.2',
            unit: '%',
            collection_date: '2026-04-15',
            page: 2,
            bbox: [50, 200, 200, 30],
            quote: 'HbA1c 7.2 %',
            confidence: 0.9,
        },
    ],
    ordering_provider: {
        name: 'Dr. Anjali Rao',
        page: 1,
        bbox: [400, 700, 200, 20],
        quote: 'Ordering: Dr. Anjali Rao',
        confidence: 0.85,
    },
});

const baseState = (overrides?: Partial<PipelineState>): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-1',
        docType: 'lab_pdf',
        pid: 101,
        triggerSource: 'panel',
    }),
    status: 'validated',
    schema: labExtraction(),
    ...overrides,
});

const fetchChenContext = (): PatientMatchDeps['fetchChartDemographics'] =>
    vi.fn(() => Promise.resolve(chartChen));

describe('patientMatch node', () => {
    it('exact match — name 1.0 + DOB 1.0 → status="matched" with confidence_signal recorded', async () => {
        const fetch = fetchChenContext();
        const result = await patientMatch(baseState(), {
            logger: noopLogger,
            fetchChartDemographics: fetch,
        });

        expect(result.status).toBe('matched');
        expect(result.errors).toBeUndefined();
        const signal = result.confidenceSignal!;
        expect(signal).toBeDefined();
        expect(signal.patientMatchScore).toBe(1.0);
        expect(signal.patientMatchPartial).toBe(false);
        expect(signal.demographicsWarnings).toEqual([]);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('off-by-one DOB — name 1.0 + DOB 0.5 → status="matched", partial flag true, warning recorded', async () => {
        const result = await patientMatch(
            baseState({ schema: labExtraction({ dob: '1967-08-15' }) }),
            { logger: noopLogger, fetchChartDemographics: fetchChenContext() },
        );

        expect(result.status).toBe('matched');
        expect(result.errors).toBeUndefined();
        const signal = result.confidenceSignal!;
        expect(signal.patientMatchPartial).toBe(true);
        // Combined score is the average of name (1.0) and DOB (0.5) — 0.75.
        expect(signal.patientMatchScore).toBeCloseTo(0.75, 5);
        expect(signal.demographicsWarnings).toContain('dob_off_by_one_day');
    });

    it('different surname — name 0.0 → status="failed/patient_mismatch" with mismatch_reason in details', async () => {
        const result = await patientMatch(
            baseState({ schema: labExtraction({ name: 'Robert Kowalski' }) }),
            { logger: noopLogger, fetchChartDemographics: fetchChenContext() },
        );

        expect(result.status).toBe('failed');
        expect(result.errors).toHaveLength(1);
        const err = result.errors![0]!;
        expect(err.code).toBe('patient_mismatch');
        expect(err.details?.['mismatch_reason']).toBeDefined();
        expect(String(err.details?.['mismatch_reason'])).toContain('name');
        // confidenceSignal is not written when we refuse — the artifact's
        // failure mode is the load-bearing signal, not the partial score.
        expect(result.confidenceSignal).toBeUndefined();
    });

    it('different DOB year — DOB 0.0 surfaces as warning but does not fail the pipeline', async () => {
        // DOB transcription errors are common on intake/referral
        // documents; the gate degrades to a `dob_mismatch` warning
        // instead of refusing the extraction. Name still has to
        // match for the document to flow.
        const result = await patientMatch(
            baseState({ schema: labExtraction({ dob: '1980-08-14' }) }),
            { logger: noopLogger, fetchChartDemographics: fetchChenContext() },
        );

        expect(result.status).toBe('matched');
        const signal = result.confidenceSignal!;
        expect(signal.demographicsWarnings).toContain('dob_mismatch');
        expect(signal.patientMatchPartial).toBe(true);
    });

    it('partial name (surname + initial) + exact DOB → status="matched", partial flag true', async () => {
        // "Maggie Chen" against chart "Margaret L. Chen": same surname,
        // same first-initial → 0.6, DOB exact → 1.0. Combined 0.8, partial flag set.
        const result = await patientMatch(
            baseState({ schema: labExtraction({ name: 'Maggie Chen' }) }),
            { logger: noopLogger, fetchChartDemographics: fetchChenContext() },
        );

        expect(result.status).toBe('matched');
        const signal = result.confidenceSignal!;
        expect(signal.patientMatchPartial).toBe(true);
        expect(signal.patientMatchScore).toBeCloseTo(0.8, 5);
        expect(signal.demographicsWarnings).toContain('name_partial_match');
    });

    it('upstream failed status short-circuits — node returns no-op partial', async () => {
        const fetch = fetchChenContext();
        const upstreamErrors = [
            { code: 'schema_invalid' as const, message: 'upstream failure' },
        ];
        const result = await patientMatch(
            baseState({ status: 'failed', errors: upstreamErrors }),
            { logger: noopLogger, fetchChartDemographics: fetch },
        );

        // Short-circuit: don't fetch, don't write confidence_signal,
        // don't append a duplicate error.
        expect(fetch).not.toHaveBeenCalled();
        expect(result).toEqual({});
    });

    it('snapshot fetch failure → status="failed/patient_mismatch" so we never silently skip the gate', async () => {
        const fetch: PatientMatchDeps['fetchChartDemographics'] = vi.fn(() =>
            Promise.reject(new Error('snapshot service unreachable')),
        );

        const result = await patientMatch(baseState(), {
            logger: noopLogger,
            fetchChartDemographics: fetch,
        });

        expect(result.status).toBe('failed');
        expect(result.errors?.[0]?.code).toBe('patient_mismatch');
        expect(String(result.errors?.[0]?.details?.['mismatch_reason'])).toContain('snapshot');
    });

    it('extracted schema missing demographics block → status="failed/patient_mismatch"', async () => {
        const broken = labExtraction();
        delete (broken)['patient_demographics'];

        const result = await patientMatch(baseState({ schema: broken }), {
            logger: noopLogger,
            fetchChartDemographics: fetchChenContext(),
        });

        expect(result.status).toBe('failed');
        expect(result.errors?.[0]?.code).toBe('patient_mismatch');
    });

    it('chart demographics missing DOB → DOB axis 0.0 surfaces as warning, name match still flows', async () => {
        const fetch: PatientMatchDeps['fetchChartDemographics'] = vi.fn(() =>
            Promise.resolve({
                ...chartChen,
                dateOfBirth: null,
                ageYears: null,
            }),
        );

        const result = await patientMatch(baseState(), {
            logger: noopLogger,
            fetchChartDemographics: fetch,
        });

        expect(result.status).toBe('matched');
        expect(result.confidenceSignal?.demographicsWarnings).toContain('dob_mismatch');
    });

    it('intake_form schema is dispatched the same as lab_pdf', async () => {
        const intake = {
            patient_demographics: {
                name: {
                    value: 'Margaret L. Chen',
                    page: 1,
                    bbox: [10, 10, 100, 20],
                    quote: 'Margaret Chen',
                    confidence: 0.95,
                },
                dob: {
                    value: '1967-08-14',
                    page: 1,
                    bbox: [10, 30, 100, 20],
                    quote: '1967-08-14',
                    confidence: 0.9,
                },
                sex: {
                    value: 'female',
                    page: 1,
                    bbox: [10, 50, 100, 20],
                    quote: 'F',
                    confidence: 0.9,
                },
            },
            allergies: [],
            current_medications: [],
            past_medical_history: [],
            family_history: [],
        };

        const result = await patientMatch(
            baseState({ docType: 'intake_form', schema: intake }),
            { logger: noopLogger, fetchChartDemographics: fetchChenContext() },
        );

        expect(result.status).toBe('matched');
        const signal = result.confidenceSignal!;
        expect(signal.patientMatchScore).toBe(1.0);
    });
});
