/**
 * §B.4 Intake-form extraction schema.
 *
 * Strict-typed Zod schema for what the vision node must extract from a
 * patient intake form. Same per-field envelope and `.passthrough()`
 * convention as `labPdf.ts` — see that file's header for the full
 * rationale. The shape covers the five categories the W2 demographics-
 * delta detection reads (Q2b): demographics, allergies, current
 * medications, past medical history, family history.
 *
 * Free-text fields (allergy reaction, medication directions, history
 * notes) come through verbatim; structuring them into chart-shaped
 * codes (RxNorm, ICD-10) is Tier-3 promotion's job, not the vision
 * node's. The PHP DTO at
 * `interface/modules/.../src/Pipeline/IntakeFormExtraction.php`
 * mirrors this shape for the OpenEMR-side persistence parity.
 */

import { z } from 'zod';

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const citedField = <T extends z.ZodTypeAny>(value: T) =>
    z
        .object({
            value,
            page: z.number().int().positive(),
            bbox: bboxSchema,
            quote: z.string().min(1),
            confidence: z.number().min(0).max(1),
        })
        .passthrough();

const sexSchema = z.enum(['male', 'female', 'other', 'unknown']);

const demographicsSchema = z
    .object({
        name: citedField(z.string().min(1)),
        dob: citedField(z.string().min(1)),
        sex: citedField(sexSchema),
        address: citedField(z.string().min(1)).optional(),
        phone: citedField(z.string().min(1)).optional(),
        email: citedField(z.string().min(1)).optional(),
    })
    .passthrough();

const allergySchema = z
    .object({
        substance: z.string().min(1),
        reaction: z.string().min(1).optional(),
        severity: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: bboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

/**
 * MedicationStatement-shaped: drug name + free-text directions/dose/
 * frequency as the patient reports them on the form. RxNorm coding is
 * Tier-3's job.
 */
const medicationSchema = z
    .object({
        name: z.string().min(1),
        dose: z.string().min(1).optional(),
        frequency: z.string().min(1).optional(),
        route: z.string().min(1).optional(),
        notes: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: bboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const pastMedicalHistoryEntrySchema = z
    .object({
        condition: z.string().min(1),
        onset_year: z.string().min(1).optional(),
        notes: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: bboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const familyHistoryEntrySchema = z
    .object({
        relation: z.string().min(1),
        condition: z.string().min(1),
        notes: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: bboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

export const intakeFormSchema = z
    .object({
        patient_demographics: demographicsSchema,
        allergies: z.array(allergySchema),
        current_medications: z.array(medicationSchema),
        past_medical_history: z.array(pastMedicalHistoryEntrySchema),
        family_history: z.array(familyHistoryEntrySchema),
    })
    .passthrough();

export type IntakeFormExtraction = z.infer<typeof intakeFormSchema>;
