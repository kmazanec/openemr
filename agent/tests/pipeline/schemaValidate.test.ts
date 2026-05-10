/**
 * §B.5 schemaValidate node tests.
 *
 * Three behavioral cases the sub-phase calls out:
 *   1. Pass-through happy path — strict-valid vision output yields
 *      `{status: 'validated'}` and the schema slot is unchanged.
 *   2. Schema-invalid — required field missing → `failed/schema_invalid`
 *      with structured `path` for each issue.
 *   3. Bbox-missing — a cited field inside an array lacks `bbox`/`page`;
 *      that one field is dropped, the rest of the extraction parses
 *      and the node returns `validated` (per W2_ARCHITECTURE.md §"Failure
 *      Modes" — "Bbox missing for a field: Field dropped during
 *      validation").
 *
 * The schemaValidate node is defense-in-depth: vision already runs the
 * same safeParse internally. These tests pin behavior assuming a
 * caller that bypasses or precedes vision's check (e.g., a regenerated
 * artifact replay that skipped vision, or a future invoker that sets
 * `state.schema` directly).
 */

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
    schemaValidate,
    type SchemaValidateDeps,
} from '../../src/pipeline/nodes/schemaValidate.js';
import { initialPipelineState, type PipelineState } from '../../src/pipeline/state.js';

const noopLogger = pino({ level: 'silent' });

const deps: SchemaValidateDeps = { logger: noopLogger };

const baseState = (overrides?: Partial<PipelineState>): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-1',
        docType: 'lab_pdf',
        pid: 101,
        triggerSource: 'panel',
    }),
    status: 'extracted',
    ...overrides,
});

type Json = Record<string, unknown>;

const validLabExtraction = (): Json => ({
    patient_demographics: {
        name: { value: 'Jane Doe', page: 1, bbox: [50, 50, 350, 50, 350, 80, 50, 80], quote: 'Jane Doe', confidence: 0.95 },
        dob: { value: '1980-05-12', page: 1, bbox: [50, 100, 350, 100, 350, 130, 50, 130], quote: '05/12/1980', confidence: 0.9 },
        sex: { value: 'female', page: 1, bbox: [50, 150, 350, 150, 350, 180, 50, 180], quote: 'F', confidence: 0.85 },
    },
    results: [
        {
            analyte_name: 'HbA1c',
            value: '7.2',
            unit: '%',
            collection_date: '2026-04-15',
            page: 2,
            bbox: [60, 250, 660, 250, 660, 290, 60, 290],
            quote: 'HbA1c 7.2 %',
            confidence: 0.92,
        },
    ],
    ordering_provider: {
        name: 'Dr. Alice Smith',
        page: 1,
        bbox: [500, 850, 900, 850, 900, 880, 500, 880],
        quote: 'Ordering: Dr. Alice Smith',
        confidence: 0.88,
    },
});

const validIntakeExtraction = (): Json => ({
    patient_demographics: {
        name: { value: 'John Roe', page: 1, bbox: [50, 50, 350, 50, 350, 80, 50, 80], quote: 'John Roe', confidence: 0.9 },
        dob: { value: '1970-01-01', page: 1, bbox: [50, 100, 350, 100, 350, 130, 50, 130], quote: '01/01/1970', confidence: 0.9 },
        sex: { value: 'male', page: 1, bbox: [50, 150, 350, 150, 350, 180, 50, 180], quote: 'M', confidence: 0.9 },
    },
    allergies: [],
    current_medications: [],
    past_medical_history: [],
    family_history: [],
});

describe('schemaValidate node', () => {
    it('happy path lab_pdf — passes strict-valid extraction through with status="validated"', () => {
        const extraction = validLabExtraction();
        const state = baseState({ schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('validated');
        expect(result.schema).toEqual(extraction);
        expect(result.errors).toBeUndefined();
    });

    it('happy path intake_form — passes strict-valid extraction through with status="validated"', () => {
        const extraction = validIntakeExtraction();
        const state = baseState({ docType: 'intake_form', schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('validated');
        expect(result.schema).toEqual(extraction);
    });

    it('schema-invalid — missing required field on demographics returns failed/schema_invalid with path detail', () => {
        const extraction = validLabExtraction();
        const demographics = extraction['patient_demographics'] as Json;
        delete demographics['dob'];
        const state = baseState({ schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('failed');
        expect(result.errors).toBeDefined();
        expect(result.errors).toHaveLength(1);
        const err = result.errors![0]!;
        expect(err.code).toBe('schema_invalid');
        const issues = (err.details?.['issues'] ?? []) as readonly string[];
        expect(issues.some((i) => i.includes('patient_demographics.dob'))).toBe(true);
    });

    it('schema-invalid — null schema (vision never ran) returns failed/schema_invalid', () => {
        const state = baseState({ schema: null });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('failed');
        expect(result.errors?.[0]?.code).toBe('schema_invalid');
    });

    it('bbox-missing on array element — drops that element and validates the rest', () => {
        const extraction = validLabExtraction();
        const results = extraction['results'] as Json[];
        results.push({
            analyte_name: 'Glucose',
            value: '120',
            unit: 'mg/dL',
            collection_date: '2026-04-15',
            page: 2,
            quote: 'Glucose 120 mg/dL',
            confidence: 0.7,
        });
        const state = baseState({ schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('validated');
        expect(result.errors).toBeUndefined();
        const validated = result.schema as { results: readonly { analyte_name: string }[] };
        expect(validated.results).toHaveLength(1);
        expect(validated.results[0]!.analyte_name).toBe('HbA1c');
    });

    it('bbox-missing on optional cited field — drops the optional field and validates', () => {
        const extraction = validIntakeExtraction();
        const demographics = extraction['patient_demographics'] as Json;
        demographics['address'] = {
            value: '123 Main St',
            page: 1,
            quote: '123 Main St',
            confidence: 0.8,
        };
        const state = baseState({ docType: 'intake_form', schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('validated');
        const validated = result.schema as { patient_demographics: { address?: unknown } };
        expect(validated.patient_demographics.address).toBeUndefined();
    });

    it('bbox-missing on a required cited field — fails (the field cannot be dropped silently)', () => {
        const extraction = validLabExtraction();
        const demographics = extraction['patient_demographics'] as Record<string, Json>;
        delete demographics['name']!['page'];
        const state = baseState({ schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('failed');
        expect(result.errors?.[0]?.code).toBe('schema_invalid');
    });

    it('bbox-missing on every element of a min(1) array — fails (results must have at least one valid row)', () => {
        const extraction = validLabExtraction();
        const results = extraction['results'] as Json[];
        delete results[0]!['bbox'];
        const state = baseState({ schema: extraction });

        const result = schemaValidate(state, deps);

        expect(result.status).toBe('failed');
        expect(result.errors?.[0]?.code).toBe('schema_invalid');
    });
});
