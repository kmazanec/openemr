/**
 * §B.4 Schema-shape tests for the lab-PDF and intake-form Zod schemas.
 *
 * These tests cover the schema's contract independent of the vision
 * call: required fields are required, unknown fields pass through, the
 * cited-field envelope is enforced uniformly, and the bbox tuple shape
 * matches `SourceReferenceSchema` so the resolver downstream can reuse
 * one path.
 */

import { describe, expect, it } from 'vitest';

import { intakeFormSchema, type IntakeFormExtraction } from '../../src/pipeline/schemas/intakeForm.js';
import { labPdfSchema, type LabPdfExtraction } from '../../src/pipeline/schemas/labPdf.js';

const validLabPdf = (): LabPdfExtraction => ({
    patient_demographics: {
        name: { value: 'Jane Doe', page: 1, bbox: [10, 10, 100, 20], quote: 'Jane Doe', confidence: 0.95 },
        dob: { value: '1980-05-12', page: 1, bbox: [10, 30, 100, 20], quote: '05/12/1980', confidence: 0.9 },
        sex: { value: 'female', page: 1, bbox: [10, 50, 100, 20], quote: 'F', confidence: 0.85 },
    },
    results: [
        {
            analyte_name: 'HbA1c',
            value: '7.2',
            unit: '%',
            ref_range_low: '4.0',
            ref_range_high: '5.6',
            abnormal_flag: 'high',
            collection_date: '2026-04-15',
            page: 2,
            bbox: [50, 200, 200, 30],
            quote: 'HbA1c 7.2 %',
            confidence: 0.92,
        },
    ],
    ordering_provider: {
        name: 'Dr. Alice Smith',
        npi: '1234567890',
        page: 1,
        bbox: [400, 700, 200, 20],
        quote: 'Ordering: Dr. Alice Smith NPI 1234567890',
        confidence: 0.88,
    },
});

const validIntakeForm = (): IntakeFormExtraction => ({
    patient_demographics: {
        name: { value: 'John Roe', page: 1, bbox: [10, 10, 100, 20], quote: 'John Roe', confidence: 0.9 },
        dob: { value: '1970-01-01', page: 1, bbox: [10, 30, 100, 20], quote: '01/01/1970', confidence: 0.9 },
        sex: { value: 'male', page: 1, bbox: [10, 50, 100, 20], quote: 'M', confidence: 0.9 },
    },
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'moderate',
            page: 2,
            bbox: [10, 100, 200, 20],
            quote: 'Penicillin — hives, moderate',
            confidence: 0.9,
        },
    ],
    current_medications: [
        {
            name: 'Metformin',
            dose: '500 mg',
            frequency: 'twice daily',
            page: 2,
            bbox: [10, 200, 200, 20],
            quote: 'Metformin 500mg BID',
            confidence: 0.9,
        },
    ],
    past_medical_history: [
        {
            condition: 'Type 2 Diabetes',
            onset_year: '2018',
            page: 3,
            bbox: [10, 100, 200, 20],
            quote: 'T2DM dx 2018',
            confidence: 0.85,
        },
    ],
    family_history: [
        {
            relation: 'mother',
            condition: 'Coronary artery disease',
            page: 3,
            bbox: [10, 200, 200, 20],
            quote: 'Mother: CAD',
            confidence: 0.85,
        },
    ],
});

describe('labPdfSchema', () => {
    it('accepts a fully-populated valid extraction', () => {
        const result = labPdfSchema.safeParse(validLabPdf());
        expect(result.success).toBe(true);
    });

    it('passes unknown top-level keys through silently', () => {
        const input = { ...validLabPdf(), specimen_collection_method: 'venipuncture' } as unknown;
        const result = labPdfSchema.safeParse(input);
        expect(result.success).toBe(true);
    });

    it('rejects when a required cited field is missing bbox', () => {
        const input = validLabPdf();
        const broken = {
            ...input,
            patient_demographics: {
                ...input.patient_demographics,
                name: { value: 'Jane Doe', page: 1, quote: 'Jane Doe', confidence: 0.9 },
            },
        };
        const result = labPdfSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });

    it('rejects when results is empty (a lab PDF with zero results is degenerate)', () => {
        const input = { ...validLabPdf(), results: [] };
        const result = labPdfSchema.safeParse(input);
        expect(result.success).toBe(false);
    });

    it('rejects out-of-range confidence values', () => {
        const input = validLabPdf();
        const broken = {
            ...input,
            results: [{ ...input.results[0], confidence: 1.7 }],
        };
        const result = labPdfSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });

    it('rejects non-positive page numbers (page 0 is not a 1-indexed page)', () => {
        const input = validLabPdf();
        const broken = {
            ...input,
            results: [{ ...input.results[0], page: 0 }],
        };
        const result = labPdfSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });

    it('accepts results without optional reference range / abnormal flag', () => {
        const input = validLabPdf();
        const minimal = {
            ...input,
            results: [
                {
                    analyte_name: 'Hemoglobin',
                    value: '14.0',
                    unit: 'g/dL',
                    collection_date: '2026-04-15',
                    page: 2,
                    bbox: [50, 220, 200, 20],
                    quote: 'Hgb 14.0 g/dL',
                    confidence: 0.9,
                },
            ],
        };
        const result = labPdfSchema.safeParse(minimal);
        expect(result.success).toBe(true);
    });

    it('rejects an abnormal_flag outside the closed enumeration', () => {
        const input = validLabPdf();
        const broken = {
            ...input,
            results: [{ ...input.results[0], abnormal_flag: 'wonky' }],
        };
        const result = labPdfSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });
});

describe('intakeFormSchema', () => {
    it('accepts a fully-populated valid extraction', () => {
        const result = intakeFormSchema.safeParse(validIntakeForm());
        expect(result.success).toBe(true);
    });

    it('accepts empty arrays for the list categories (an intake with no allergies is valid)', () => {
        const minimal: IntakeFormExtraction = {
            patient_demographics: validIntakeForm().patient_demographics,
            allergies: [],
            current_medications: [],
            past_medical_history: [],
            family_history: [],
        };
        const result = intakeFormSchema.safeParse(minimal);
        expect(result.success).toBe(true);
    });

    it('passes unknown top-level keys through silently', () => {
        const input = { ...validIntakeForm(), insurance_carrier: 'Acme Health' } as unknown;
        const result = intakeFormSchema.safeParse(input);
        expect(result.success).toBe(true);
    });

    it('rejects when patient_demographics is missing entirely', () => {
        const input = validIntakeForm();
        const broken: Partial<IntakeFormExtraction> = { ...input };
        delete broken.patient_demographics;
        const result = intakeFormSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });

    it('rejects when an allergy is missing the bbox tuple', () => {
        const input = validIntakeForm();
        const broken = {
            ...input,
            allergies: [{ substance: 'Penicillin', page: 2, quote: 'Penicillin', confidence: 0.9 }],
        };
        const result = intakeFormSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });

    it('rejects a sex value outside the closed enumeration', () => {
        const input = validIntakeForm();
        const broken = {
            ...input,
            patient_demographics: {
                ...input.patient_demographics,
                sex: { ...input.patient_demographics.sex, value: 'unspecified' },
            },
        };
        const result = intakeFormSchema.safeParse(broken);
        expect(result.success).toBe(false);
    });

    it('accepts sex value "unknown" (closed-enum member, not an open string)', () => {
        const input = validIntakeForm();
        const ok = {
            ...input,
            patient_demographics: {
                ...input.patient_demographics,
                sex: { ...input.patient_demographics.sex, value: 'unknown' },
            },
        };
        const result = intakeFormSchema.safeParse(ok);
        expect(result.success).toBe(true);
    });

    it('accepts demographics with optional address / phone / email present', () => {
        const input = validIntakeForm();
        const withContact = {
            ...input,
            patient_demographics: {
                ...input.patient_demographics,
                address: {
                    value: '123 Main St',
                    page: 1,
                    bbox: [10, 70, 200, 20],
                    quote: '123 Main St',
                    confidence: 0.9,
                },
                phone: {
                    value: '555-0100',
                    page: 1,
                    bbox: [10, 90, 200, 20],
                    quote: '555-0100',
                    confidence: 0.9,
                },
            },
        };
        const result = intakeFormSchema.safeParse(withContact);
        expect(result.success).toBe(true);
    });
});
