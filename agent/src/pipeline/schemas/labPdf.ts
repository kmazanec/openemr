/**
 * §B.4 Lab-PDF extraction schema.
 *
 * Strict-typed Zod schema for what the vision node must extract from a
 * lab PDF. Mirrors `W2_ARCHITECTURE.md` §"Vision call":
 *
 *   - Every cited field is `{value, page, bbox, quote, confidence}`.
 *   - `.passthrough()` (Zod) silently drops unknown keys — the model can
 *     emit extra fields without breaking the parse, but we never ingest
 *     them. Required fields are hard errors at parse time.
 *   - `bbox` is `[x, y, w, h]` with each component an INTEGER on a
 *     0..1000 grid normalized to the page image. Integer-grid
 *     coordinates dodge the model's tendency to round normalized
 *     fractions to one decimal (which on a letter-sized page is ~5
 *     rows of error); the grid is dense enough that the model can
 *     emit useful precision without thinking about decimals at all.
 *     The panel divides each component by 10 to render a CSS
 *     percentage. Same tuple here keeps the resolver path one-step.
 *
 * The PHP DTO at
 * `interface/modules/.../src/Pipeline/LabPdfExtraction.php` mirrors this
 * shape for the OpenEMR-side persistence parity.
 */

import { z } from 'zod';

/**
 * Per-field citation envelope. Every cited field carries the bbox + page
 * + quote + confidence that the verifier (W1 §6.2 carry-forward, W2
 * `documentEvidenceRetriever`) needs to resolve back to the source PDF.
 *
 * `confidence` is the model's *self-reported* confidence; the eval suite
 * cross-checks it against external rubrics (`schema_valid`,
 * `factually_consistent`). It is never blindly trusted for routing.
 */
const bboxSchema = z.tuple([
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
]);

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
    })
    .passthrough();

const abnormalFlagSchema = z.enum(['high', 'low', 'critical_high', 'critical_low', 'normal']);

/**
 * One result row on a lab panel. `panel_code` is LOINC or local; we
 * accept whatever the lab reports it as (the Tier-3 promotion path
 * normalizes downstream). Reference range bounds are optional because
 * not every analyte has them (e.g., qualitative tests).
 */
const resultSchema = z
    .object({
        panel_code: z.string().min(1).optional(),
        analyte_name: z.string().min(1),
        value: z.string().min(1),
        unit: z.string().min(1),
        ref_range_low: z.string().min(1).optional(),
        ref_range_high: z.string().min(1).optional(),
        abnormal_flag: abnormalFlagSchema.optional(),
        collection_date: z.string().min(1),
        page: z.number().int().positive(),
        bbox: bboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const orderingProviderSchema = z
    .object({
        name: z.string().min(1),
        npi: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: bboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

export const labPdfSchema = z
    .object({
        patient_demographics: demographicsSchema,
        results: z.array(resultSchema).min(1),
        ordering_provider: orderingProviderSchema,
    })
    .passthrough();

export type LabPdfExtraction = z.infer<typeof labPdfSchema>;
