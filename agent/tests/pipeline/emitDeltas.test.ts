/**
 * §B.7 emitDeltas node tests. Pins the lab-PDF vs intake-form
 * dispatch, the new-allergy / new-medication / new-diagnosis diff
 * logic, demographics-change detection, and the failure-soft posture
 * (chart-fetch errors degrade the UI but never poison chart state).
 */

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
    emitDeltas,
    type EmitDeltasDeps,
    type ExtractedFactsDelta,
} from '../../src/pipeline/nodes/emitDeltas.js';
import {
    initialPipelineState,
    type PipelineState,
} from '../../src/pipeline/state.js';
import type { ChartSnapshot, SourceReference } from '../../src/snapshot/types.js';
import {
    type ArtifactStatus,
    type ExtractionArtifact,
    type ExtractionArtifactStore,
} from '../../src/state/extractionArtifacts.js';

const noopLogger = pino({ level: 'silent' });

const dummySource: SourceReference = {
    source_type: 'chart',
    source_id: 'x',
    locator: {},
    quote: 'q',
};

const baseChart = (overrides: Partial<ChartSnapshot> = {}): ChartSnapshot => ({
    patient: {
        pid: 4242,
        uuid: 'u',
        displayName: 'Margaret Chen',
        sex: 'female',
        dateOfBirth: '1967-08-14',
        ageYears: 58,
        source: dummySource,
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    ...overrides,
});

const stubArtifactStore = (): {
    store: ExtractionArtifactStore;
    updates: { artifactId: string; deltas: unknown }[];
} => {
    const updates: { artifactId: string; deltas: unknown }[] = [];
    const store: ExtractionArtifactStore = {
        claimDocumentLock: vi.fn(),
        findArtifactByDocumentHash: vi.fn(),
        insertArtifact: vi.fn(),
        updateArtifactStatus: vi.fn(
            (
                artifactId: string,
                _status: ArtifactStatus,
                metadata?: { readonly deltasJson?: unknown },
            ): Promise<ExtractionArtifact | null> => {
                updates.push({ artifactId, deltas: metadata?.deltasJson });
                return Promise.resolve(null);
            },
        ),
        searchArtifacts: vi.fn(),
        recordDisposition: vi.fn(),
        getDispositions: vi.fn(),
    };
    return { store, updates };
};

const buildState = (overrides: Partial<PipelineState> = {}): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-1',
        docType: 'intake_form',
        pid: 4242,
        triggerSource: 'panel',
    }),
    artifactId: 'artifact-1',
    status: 'persisted',
    ...overrides,
});

const buildDeps = (
    chart: ChartSnapshot,
    overrides: Partial<EmitDeltasDeps> = {},
): { deps: EmitDeltasDeps; updates: { artifactId: string; deltas: unknown }[] } => {
    const { store, updates } = stubArtifactStore();
    return {
        deps: {
            artifactStore: store,
            logger: noopLogger,
            fetchChartSnapshot: vi.fn(() => Promise.resolve(chart)),
            ...overrides,
        },
        updates,
    };
};

describe('emitDeltas', () => {
    it('intake_form: detects a brand-new allergy not on the chart', async () => {
        const chart = baseChart({
            allergies: [
                { substance: 'Penicillin', reaction: 'hives', severity: 'moderate', source: dummySource },
            ],
        });
        const schema = {
            patient_demographics: {
                name: { value: 'Margaret Chen', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                dob: { value: '1967-08-14', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                sex: { value: 'female', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
            },
            allergies: [
                { substance: 'Sulfa drugs', page: 2, bbox: [0, 0, 1, 1], quote: 'sulfa', confidence: 0.9 },
                { substance: 'penicillin', page: 2, bbox: [0, 0, 1, 1], quote: 'pcn', confidence: 0.9 },
            ],
            current_medications: [],
            past_medical_history: [],
            family_history: [],
        };

        const { deps, updates } = buildDeps(chart);
        const out = await emitDeltas(buildState({ schema }), deps);

        expect(out.status).toBe('persisted');
        expect(updates).toHaveLength(1);
        const delta = updates[0]!.deltas as ExtractedFactsDelta;
        expect(delta.newAllergies).toHaveLength(1);
        expect(delta.newAllergies[0]).toEqual({
            fieldPath: 'allergies[0]',
            substance: 'Sulfa drugs',
        });
    });

    it('intake_form: filters medications already on prescription or medication-statement list', async () => {
        const chart = baseChart({
            prescriptions: [
                {
                    name: 'lisinopril',
                    dose: '10mg',
                    route: null,
                    frequency: 'qd',
                    startDate: null,
                    stopDate: null,
                    prescriber: null,
                    indication: null,
                    prescriptionId: '7001',
                    source: dummySource,
                },
            ],
            medications: [
                {
                    name: 'metformin',
                    dose: '500mg',
                    usageCategory: null,
                    informationSource: null,
                    startDate: null,
                    stopDate: null,
                    listId: null,
                    source: dummySource,
                },
            ],
        });
        const schema = {
            patient_demographics: {
                name: { value: 'M', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                dob: { value: '1967-08-14', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                sex: { value: 'female', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
            },
            allergies: [],
            current_medications: [
                { name: 'Lisinopril', page: 2, bbox: [0, 0, 1, 1], quote: 'l', confidence: 0.9 },
                { name: 'METFORMIN', page: 2, bbox: [0, 0, 1, 1], quote: 'm', confidence: 0.9 },
                { name: 'Atorvastatin', page: 2, bbox: [0, 0, 1, 1], quote: 'a', confidence: 0.9 },
            ],
            past_medical_history: [],
            family_history: [],
        };

        const { deps, updates } = buildDeps(chart);
        await emitDeltas(buildState({ schema }), deps);
        const delta = updates[0]!.deltas as ExtractedFactsDelta;
        expect(delta.newMedications).toEqual([
            { fieldPath: 'current_medications[2]', name: 'Atorvastatin' },
        ]);
    });

    it('intake_form: surfaces address/phone/email demographics changes when present', async () => {
        const chart = baseChart();
        const schema = {
            patient_demographics: {
                name: { value: 'M Chen', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                dob: { value: '1967-08-14', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                sex: { value: 'female', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                address: { value: '123 New St', page: 1, bbox: [0, 0, 1, 1], quote: 'a', confidence: 0.9 },
                phone: { value: '555-1212', page: 1, bbox: [0, 0, 1, 1], quote: 'p', confidence: 0.9 },
            },
            allergies: [],
            current_medications: [],
            past_medical_history: [],
            family_history: [],
        };
        const { deps, updates } = buildDeps(chart);
        await emitDeltas(buildState({ schema }), deps);
        const delta = updates[0]!.deltas as ExtractedFactsDelta;
        expect(delta.demographicsChanges.map((d) => d.field)).toEqual(['address', 'phone']);
        expect(delta.demographicsChanges[0]!.extractedValue).toBe('123 New St');
    });

    it('lab_pdf: never produces new_* clinical facts (those land at Tier-3 promotion only)', async () => {
        const chart = baseChart();
        const schema = {
            patient_demographics: {
                name: { value: 'CHEN', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                dob: { value: '1967-08-14', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
                sex: { value: 'female', page: 1, bbox: [0, 0, 1, 1], quote: 'q', confidence: 1 },
            },
            results: [
                {
                    analyte_name: 'A1c',
                    value: '7.2',
                    unit: '%',
                    collection_date: '2026-04-30',
                    page: 1,
                    bbox: [0, 0, 1, 1],
                    quote: '7.2',
                    confidence: 0.95,
                },
            ],
            ordering_provider: { name: 'Dr P', page: 1, bbox: [0, 0, 1, 1], quote: 'p', confidence: 0.9 },
        };

        const { deps, updates } = buildDeps(chart);
        await emitDeltas(buildState({ docType: 'lab_pdf', schema }), deps);
        const delta = updates[0]!.deltas as ExtractedFactsDelta;
        expect(delta.newAllergies).toEqual([]);
        expect(delta.newDiagnoses).toEqual([]);
        expect(delta.newMedications).toEqual([]);
    });

    it('upstream failed short-circuits with no chart fetch', async () => {
        const fetchSpy = vi.fn();
        const out = await emitDeltas(
            buildState({ status: 'failed' }),
            buildDeps(baseChart()).deps,
        );
        expect(out).toEqual({});
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('null artifactId after persist is a structural failure', async () => {
        const out = await emitDeltas(
            buildState({ artifactId: null }),
            buildDeps(baseChart()).deps,
        );
        expect(out.status).toBe('failed');
    });

    it('chart-fetch failure degrades to empty deltas, never fails the pipeline', async () => {
        const { deps, updates } = buildDeps(baseChart(), {
            fetchChartSnapshot: vi.fn(() => Promise.reject(new Error('snapshot down'))),
        });
        const out = await emitDeltas(buildState({ schema: { allergies: [] } }), deps);
        expect(out.status).toBe('persisted');
        expect(updates).toHaveLength(1);
        const delta = updates[0]!.deltas as ExtractedFactsDelta;
        expect(delta.newAllergies).toEqual([]);
        expect(delta.newDiagnoses).toEqual([]);
        expect(delta.newMedications).toEqual([]);
    });

    it('updateArtifactStatus failure logs but does not fail pipeline', async () => {
        const { store } = stubArtifactStore();
        const failingStore: ExtractionArtifactStore = {
            ...store,
            updateArtifactStatus: vi.fn(() => Promise.reject(new Error('DB down'))),
        };
        const out = await emitDeltas(
            buildState({ schema: { allergies: [] } }),
            {
                artifactStore: failingStore,
                logger: noopLogger,
                fetchChartSnapshot: vi.fn(() => Promise.resolve(baseChart())),
            },
        );
        expect(out.status).toBe('persisted');
    });
});
