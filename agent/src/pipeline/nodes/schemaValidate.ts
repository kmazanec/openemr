/**
 * §B.5 Pipeline node 3 — `schemaValidate`.
 *
 * Strict-validate the vision output as a defense-in-depth re-parse
 * after the LLM call. The vision node already runs the same
 * `safeParse` internally; this node exists so the contract is enforced
 * even when callers bypass vision (e.g., a future replay path that
 * sets `state.schema` directly, or an offline regenerator).
 *
 * Behavior per `W2_ARCHITECTURE.md`:
 *   - `.passthrough()` semantics — unknown fields drop silently, missing
 *     required fields are hard errors.
 *   - "Bbox missing for a field" → the field is dropped (not the whole
 *     extraction). Strict-schema requires bbox + page on every cited
 *     field, so a cited field that arrives without one of them gets
 *     stripped before re-parse. If stripping leaves the extraction
 *     structurally valid, we proceed; if the dropped field was required
 *     (e.g., `patient_demographics.name`), the strict schema still
 *     rejects and we fail with `schema_invalid`.
 *
 * Dispatch is by `state.docType`, mirroring `vision`.
 */

import type { Logger } from 'pino';
import type { z } from 'zod';

import { setRunMetadata } from '../../observability/traceMetadata.js';
import { intakeFormSchema } from '../schemas/intakeForm.js';
import { labPdfSchema } from '../schemas/labPdf.js';
import { referralLetterSchema } from '../schemas/referralLetter.js';
import {
    type PipelineError,
    type PipelineState,
} from '../state.js';

export interface SchemaValidateDeps {
    readonly logger: Logger;
}

const fail = (state: PipelineState, error: PipelineError): Partial<PipelineState> => ({
    status: 'failed',
    errors: [...state.errors, error],
});

/**
 * A "cited field" is any object that carries the verifier-facing
 * envelope `{quote, confidence}` — every cited field in the extraction
 * schemas additionally requires `bbox` (a 4-tuple) and `page` (an int).
 *
 * We detect cited-field shape by the presence of `quote` *and*
 * `confidence`, both of which are required on the strict envelope. An
 * object that matches the shape but lacks `bbox` or `page` is the case
 * the architecture's "Bbox missing for a field" row addresses — we drop
 * that field rather than fail the whole extraction.
 *
 * Non-cited objects (the top-level extraction, the demographics
 * container) don't carry `quote` + `confidence` and are walked through
 * unchanged (only their cited-field children get sanitized).
 */
const looksLikeCitedField = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    return typeof obj['quote'] === 'string' && typeof obj['confidence'] === 'number';
};

const hasValidBboxAndPage = (field: Record<string, unknown>): boolean => {
    const bbox = field['bbox'];
    const page = field['page'];
    if (typeof page !== 'number' || !Number.isInteger(page) || page <= 0) return false;
    if (!Array.isArray(bbox) || bbox.length !== 4) return false;
    return bbox.every((n) => typeof n === 'number' && Number.isFinite(n));
};

/**
 * Walk the extraction tree and drop cited fields missing `bbox` or
 * `page`. Returns the count of fields dropped so the caller can log it.
 *
 *   - Object key whose value is a cited-field-shaped object missing
 *     bbox/page → key is removed.
 *   - Array element that is a cited-field-shaped object missing bbox/
 *     page → element is removed (filtered out).
 *   - All other branches are walked recursively.
 */
const sanitizeBboxMissing = (
    node: unknown,
): { sanitized: unknown; dropped: number } => {
    if (Array.isArray(node)) {
        let droppedTotal = 0;
        const out: unknown[] = [];
        for (const item of node) {
            if (looksLikeCitedField(item) && !hasValidBboxAndPage(item)) {
                droppedTotal += 1;
                continue;
            }
            const child = sanitizeBboxMissing(item);
            droppedTotal += child.dropped;
            out.push(child.sanitized);
        }
        return { sanitized: out, dropped: droppedTotal };
    }
    if (node !== null && typeof node === 'object') {
        let droppedTotal = 0;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
            if (looksLikeCitedField(value) && !hasValidBboxAndPage(value)) {
                droppedTotal += 1;
                continue;
            }
            const child = sanitizeBboxMissing(value);
            droppedTotal += child.dropped;
            out[key] = child.sanitized;
        }
        return { sanitized: out, dropped: droppedTotal };
    }
    return { sanitized: node, dropped: 0 };
};

const schemaForDocType = (docType: PipelineState['docType']): z.ZodTypeAny => {
    switch (docType) {
        case 'lab_pdf':
            return labPdfSchema;
        case 'intake_form':
            return intakeFormSchema;
        case 'referral_letter':
            return referralLetterSchema;
    }
};

export const schemaValidate = (
    state: PipelineState,
    deps: SchemaValidateDeps,
): Partial<PipelineState> => {
    const { logger } = deps;

    if (state.schema === null || state.schema === undefined) {
        return fail(state, {
            code: 'schema_invalid',
            message: 'schemaValidate received a null extraction',
            details: { issues: ['schema: extraction is null'] },
        });
    }

    const { sanitized, dropped } = sanitizeBboxMissing(state.schema);
    if (dropped > 0) {
        logger.warn(
            {
                documentUuid: state.documentUuid,
                docType: state.docType,
                droppedFields: dropped,
            },
            'schemaValidate: dropped cited fields missing bbox or page',
        );
    }

    const schema = schemaForDocType(state.docType);
    const parsed = schema.safeParse(sanitized);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        logger.warn(
            {
                documentUuid: state.documentUuid,
                docType: state.docType,
                issues,
            },
            'schemaValidate: extraction failed strict-schema parse',
        );
        return fail(state, {
            code: 'schema_invalid',
            message: 'extraction did not match the strict schema',
            details: { issues },
        });
    }

    setRunMetadata({ schema_validation_warnings: dropped > 0 ? dropped : 0 });
    return { schema: parsed.data, status: 'validated' };
};
