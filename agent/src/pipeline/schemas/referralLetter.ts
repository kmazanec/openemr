/**
 * Referral-letter extraction schema.
 *
 * Strict-typed Zod schema for what the extraction step must pull out
 * of a referral letter (typically a DOCX from a referring provider).
 * Same per-field envelope and `.passthrough()` convention as
 * `labPdf.ts` / `intakeForm.ts` — see those files' headers for the
 * full rationale.
 *
 * DOCX is machine-readable text, so the extraction path is text-only
 * (no rasterization, no vision API image input) — see
 * `agent/src/pipeline/docxText.ts` and the text-mode branch in
 * `nodes/vision.ts`. The cited-field envelope still carries
 * `{value, page, bbox, quote, confidence}` so the downstream
 * verifier and `documentEvidenceRetriever` consume snippets through
 * the same code path that handles lab/intake bbox-citations:
 *
 *   - `page` is always 1 (DOCX render-mode treats the whole letter
 *     as one logical page).
 *   - `bbox = [charStart, charEnd, 0, 0]` encodes the character span
 *     of the cited text within the rendered text body. The verifier
 *     does an exact tuple-equality check, so the encoding only has to
 *     round-trip — it does not need to be visually meaningful. The
 *     side-panel renderer (`DocumentViewerDrawer`) reads the
 *     document's MIME (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
 *     and dispatches to a text-span highlight overlay rather than
 *     PDF.js.
 *
 * The integer cap on bbox values is wider than the lab/intake
 * 0..1000 grid because character offsets in a real referral can
 * comfortably exceed 1000 across HPI + meds + labs.
 */

import { z } from 'zod';

const docxBboxSchema = z.tuple([
    z.number().int().min(0).max(1_000_000),
    z.number().int().min(0).max(1_000_000),
    z.number().int().min(0).max(1_000_000),
    z.number().int().min(0).max(1_000_000),
]);

const citedField = <T extends z.ZodTypeAny>(value: T) =>
    z
        .object({
            value,
            page: z.number().int().positive(),
            bbox: docxBboxSchema,
            quote: z.string().min(1),
            confidence: z.number().min(0).max(1),
        })
        .passthrough();

const sexSchema = z.enum(['male', 'female', 'other', 'unknown']);

const senderProviderSchema = z
    .object({
        name: citedField(z.string().min(1)),
        npi: citedField(z.string().min(1)).optional(),
        organization: citedField(z.string().min(1)).optional(),
    })
    .passthrough();

const recipientProviderSchema = z
    .object({
        name: citedField(z.string().min(1)),
        npi: citedField(z.string().min(1)).optional(),
        organization: citedField(z.string().min(1)).optional(),
    })
    .passthrough();

const patientIdentifiersSchema = z
    .object({
        name: citedField(z.string().min(1)),
        dob: citedField(z.string().min(1)),
        sex: citedField(sexSchema).optional(),
        mrn: citedField(z.string().min(1)).optional(),
    })
    .passthrough();

const pastMedicalHistoryEntrySchema = z
    .object({
        condition: z.string().min(1),
        icd10: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: docxBboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const medicationSchema = z
    .object({
        name: z.string().min(1),
        dose: z.string().min(1).optional(),
        route: z.string().min(1).optional(),
        frequency: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: docxBboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const allergyEntrySchema = z
    .object({
        substance: z.string().min(1),
        reaction: z.string().min(1).optional(),
        page: z.number().int().positive(),
        bbox: docxBboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const abnormalFlagSchema = z.enum(['high', 'low', 'critical_high', 'critical_low', 'normal']);

const pertinentLabSchema = z
    .object({
        analyte_name: z.string().min(1),
        value: z.string().min(1),
        unit: z.string().min(1),
        collection_date: z.string().min(1).optional(),
        abnormal_flag: abnormalFlagSchema.optional(),
        page: z.number().int().positive(),
        bbox: docxBboxSchema,
        quote: z.string().min(1),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

export const referralLetterSchema = z
    .object({
        referral_date: citedField(z.string().min(1)).optional(),
        sender_provider: senderProviderSchema,
        recipient_provider: recipientProviderSchema,
        patient_identifiers: patientIdentifiersSchema,
        reason_for_referral: citedField(z.string().min(1)),
        history_of_present_illness: citedField(z.string().min(1)).optional(),
        past_medical_history: z.array(pastMedicalHistoryEntrySchema),
        current_medications: z.array(medicationSchema),
        allergies: z.array(allergyEntrySchema),
        pertinent_labs: z.array(pertinentLabSchema),
        specific_question: citedField(z.string().min(1)).optional(),
    })
    .passthrough();

export type ReferralLetterExtraction = z.infer<typeof referralLetterSchema>;
