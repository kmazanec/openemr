/**
 * F.5a `POST /v1/agent/accept_fact` — middleman that turns a panel-side
 * "Accept" click into a real Tier-3 chart write.
 *
 * The panel does not have the structured artifact data (analyte/value/
 * unit/etc.) — that lives in the agent's `extraction_artifacts.schemaJson`.
 * `promote.php` does not have it either: the PHP side only knows how to
 * write a typed promotion body once it receives one. So this route is
 * the bridge:
 *
 *   1. Read the artifact by id.
 *   2. Materialize the per-type promotion body from `schemaJson` +
 *      `fieldPath`. (F.5a ships the lab branch only; the four other
 *      types return 501 with `error='not_yet_implemented'` so the panel
 *      surfaces the same typed toast it would for a direct
 *      `promote.php` call against an unimplemented type.)
 *   3. POST the body to `promote.php?type=<inferred>` with the panel's
 *      bearer token (the proxy mints with `accept_fact`-scoped JWT
 *      which carries `user/DiagnosticReport.cs`).
 *   4. On 200, record the per-fact disposition as `accepted`.
 *   5. Return `{chartRecordUuid, chartRecordType, observationUuids,
 *      idempotentHit, dispositionRolledTo}` to the panel for the toast +
 *      animated chip swap.
 *
 * Any non-200 from `promote.php` short-circuits without recording a
 * disposition: the chart write didn't happen, so the disposition row
 * shouldn't either. The panel sees a typed error envelope.
 */

import type { Context } from 'hono';
import { z } from 'zod';

import { getPrincipal, getRawToken } from '../../auth/middleware.js';
import { createLogger } from '../../observability/logger.js';
import type {
    ExtractionArtifact,
    ExtractionArtifactStore,
} from '../../state/extractionArtifacts.js';
import {
    PromoteHttpError,
    PromoteNetworkError,
    PromoteMalformedResponseError,
    type OpenEmrPromoteClient,
    type PromoteFactType,
} from '../../storage/openemrPromoteClient.js';

const acceptFactRequestSchema = z.object({
    artifactId: z.string().min(1).max(200),
    fieldPath: z.string().min(1).max(500),
    /**
     * Required: the fact type the panel inferred from the rendered
     * claim's `category`. Carried explicitly so the route can route
     * to the right materializer without re-deriving it from
     * `fieldPath`. The materializer cross-checks against the
     * artifact's `docType` + `schemaJson` shape, so a panel that
     * sends a wrong `factType` still surfaces as a 400 rather than
     * a wrong-typed `promote.php` body.
     */
    factType: z.union([
        z.literal('lab'),
        z.literal('allergy'),
        z.literal('medication_statement'),
        z.literal('past_medical_history'),
        z.literal('family_history'),
        z.literal('demographics'),
    ]),
    conversationId: z.string().min(1).max(200).optional(),
});

export interface AcceptFactRouteDeps {
    readonly store: Pick<
        ExtractionArtifactStore,
        'findArtifactById' | 'recordDisposition'
    >;
    readonly promoteClient: OpenEmrPromoteClient;
}

type Materialized =
    | { readonly body: Record<string, unknown> }
    | { readonly error: string };

/**
 * Read `patientMatchPartial` off the artifact's `confidenceSignal`
 * JSONB blob. Returns `true` when the pipeline flagged a partial
 * match (name typo, off-by-one DOB) at extraction time, `false`
 * otherwise (confident match, or no signal recorded — confident-
 * mismatch artifacts never reach Tier-3 because the pipeline writes
 * `status='failed'` for those).
 *
 * The signal is `unknown` at the type level (JSONB column), so we
 * narrow defensively. A malformed blob is treated as "not partial"
 * — a permission gate failing-open on a corrupt signal is no worse
 * than the existing pre-gate behavior, and the chart-level audit
 * still records the actor and source document.
 */
const isPartialMatchArtifact = (artifact: ExtractionArtifact): boolean => {
    const signal = artifact.confidenceSignal;
    if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
        return false;
    }
    return (signal as Record<string, unknown>)['patientMatchPartial'] === true;
};

/**
 * Materialize the F.2 lab promotion body from `schemaJson` +
 * `fieldPath`. Two source shapes feed this materializer:
 *
 *   - `lab_pdf` — schema.results[<idx>], panel + ordering provider
 *     authored by the lab. The fieldPath is `results.<n>`; the F.2
 *     body takes the whole results array.
 *   - `referral_letter` — schema.pertinent_labs[<idx>], a snippet of
 *     labs the referring provider chose to include in the letter.
 *     The fieldPath is `pertinent_labs.<n>`. The same F.2 body shape
 *     applies; collection_date may be absent on referrals
 *     (referring providers don't always record it inline) — when it
 *     is, we fall back to the artifact's createdAt date so the F.2
 *     idempotency key still resolves.
 *
 * F.2 idempotency key (`source_document_uuid`, `panel_code`,
 * `collection_date`) means a re-promote of a different fact on the
 * same panel returns the existing IDs without writing a duplicate row.
 */
const materializeLabPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    let resultsKey: 'results' | 'pertinent_labs';
    if (artifact.docType === 'lab_pdf') {
        resultsKey = 'results';
    } else if (artifact.docType === 'referral_letter') {
        resultsKey = 'pertinent_labs';
    } else {
        return { error: 'fact_type_mismatch' };
    }

    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const resultsRaw = schemaRecord[resultsKey];
    if (!Array.isArray(resultsRaw) || resultsRaw.length === 0) {
        return { error: 'schema_invalid' };
    }

    const fieldPathPattern = new RegExp(`^${resultsKey}\\.(\\d+)`);
    const fieldMatch = fieldPathPattern.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const idx = Number.parseInt(fieldMatch[1] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= resultsRaw.length) {
        return { error: 'unsupported_field_path' };
    }

    const results: Record<string, unknown>[] = [];
    let panelCode: string | null = null;
    let collectionDate: string | null = null;
    for (const row of resultsRaw) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
            return { error: 'schema_invalid' };
        }
        const r = row as Record<string, unknown>;
        const analyteName = r['analyte_name'];
        const value = r['value'];
        const unit = r['unit'];
        const collectionDateRow = r['collection_date'];
        if (
            typeof analyteName !== 'string'
            || typeof value !== 'string'
            || typeof unit !== 'string'
        ) {
            return { error: 'schema_invalid' };
        }
        // collection_date is required on lab_pdf rows; optional on
        // referral pertinent_labs (the schema allows it to be absent).
        if (artifact.docType === 'lab_pdf' && typeof collectionDateRow !== 'string') {
            return { error: 'schema_invalid' };
        }
        if (typeof collectionDateRow === 'string') {
            collectionDate ??= collectionDateRow;
        }
        if (panelCode === null && typeof r['panel_code'] === 'string') {
            panelCode = r['panel_code'];
        }
        const out: Record<string, unknown> = {
            analyte_name: analyteName,
            value,
            unit,
        };
        if (typeof r['ref_range_low'] === 'string') out['ref_range_low'] = r['ref_range_low'];
        if (typeof r['ref_range_high'] === 'string') out['ref_range_high'] = r['ref_range_high'];
        if (typeof r['abnormal_flag'] === 'string') out['abnormal_flag'] = r['abnormal_flag'];
        results.push(out);
    }

    if (collectionDate === null) {
        if (artifact.docType === 'lab_pdf') {
            return { error: 'schema_invalid' };
        }
        // Referral fallback: the letter date is the closest signal we
        // have to when the labs were drawn. Better than refusing the
        // promotion and losing the cited values entirely.
        collectionDate = artifact.createdAt.slice(0, 10);
    }

    return {
        body: {
            pid: artifact.pid,
            source_document_uuid: artifact.documentUuid,
            panel_code: panelCode,
            collection_date: collectionDate,
            results,
        },
    };
};

/**
 * Materialize the F.5d past-medical-history promotion body from
 * `schemaJson` + `fieldPath`. Two source shapes feed this materializer:
 *
 *   - `intake_form` — schema.past_medical_history[<idx>], with
 *     `condition`, optional `onset_year`, optional `notes`. No ICD
 *     code (intake forms don't ask the patient to code their PMH).
 *   - `referral_letter` — schema.past_medical_history[<idx>], same
 *     `condition` field plus an optional `icd10` string the
 *     referring provider already coded. When present, the code
 *     passes through as `diagnosis` on the F.5d body so OpenEMR's
 *     `lists.diagnosis` column lands populated rather than empty.
 *
 * F.5d body: `pid`, `source_document_uuid`, `title`, optional
 * `diagnosis` / `verification_option_id` / `comments` /
 * `onset_date`. One accepted fact promotes one row, idempotent on
 * `(source_document_uuid, lower(trim(title)))`.
 *
 * `onset_year` normalization: an intake form's "Year of onset: 2014"
 * becomes `onset_date: '2014-01-01'`. We accept any 4-digit year that
 * reasonably could be a real year of onset (1900..currentYear+1, where
 * the +1 accounts for clock skew across timezones). Anything else is
 * silently dropped from the body (the PHP DTO accepts `onset_date` as
 * optional), so a malformed `onset_year` doesn't fail the whole
 * promotion — the rest of the row still lands.
 */
const materializeMedicalProblemPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    if (artifact.docType !== 'intake_form' && artifact.docType !== 'referral_letter') {
        return { error: 'fact_type_mismatch' };
    }
    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const entriesRaw = schemaRecord['past_medical_history'];
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
        return { error: 'schema_invalid' };
    }

    const fieldMatch = /^past_medical_history\.(\d+)/.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const idx = Number.parseInt(fieldMatch[1] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= entriesRaw.length) {
        return { error: 'unsupported_field_path' };
    }

    const row: unknown = entriesRaw[idx];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return { error: 'schema_invalid' };
    }
    const r = row as Record<string, unknown>;
    const condition = r['condition'];
    if (typeof condition !== 'string' || condition.trim() === '') {
        return { error: 'schema_invalid' };
    }

    const body: Record<string, unknown> = {
        pid: artifact.pid,
        source_document_uuid: artifact.documentUuid,
        title: condition,
    };
    if (typeof r['notes'] === 'string' && r['notes'].trim() !== '') {
        body['comments'] = r['notes'];
    }
    const normalizedOnset = normalizeOnsetYear(r['onset_year']);
    if (normalizedOnset !== null) {
        body['onset_date'] = normalizedOnset;
    }
    if (typeof r['icd10'] === 'string' && r['icd10'].trim() !== '') {
        body['diagnosis'] = r['icd10'].trim();
    }
    return { body };
};

/**
 * Convert intake-form `onset_year` (a free-text 4-digit year) into the
 * `lists.begdate` shape the PHP writer expects. The intake schema only
 * carries the year, so we anchor it to Jan 1: "2014" → "2014-01-01".
 * Returns null for any value that isn't a plausible 4-digit year, which
 * causes the body to omit `onset_date` entirely (the PHP DTO accepts
 * the field as optional).
 */
const normalizeOnsetYear = (raw: unknown): string | null => {
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (!/^\d{4}$/.test(trimmed)) {
        return null;
    }
    const year = Number.parseInt(trimmed, 10);
    const currentYear = new Date().getUTCFullYear();
    if (year < 1900 || year > currentYear + 1) {
        return null;
    }
    return `${trimmed}-01-01`;
};

/**
 * Materialize the F.5c medication-statement promotion body from
 * `schemaJson` + `fieldPath`. The panel cites one
 * `current_medications[<idx>]` entry from the intake-form schema;
 * F.5c's `?type=medication_statement` endpoint takes a single
 * patient-reported medication (`pid`, `source_document_uuid`,
 * `drug_name`, optional `dosage_instructions` / `usage_category` /
 * `request_intent` / `comments` / `onset_date`) — one accepted fact
 * promotes one `lists` row + sibling `lists_medication` row,
 * idempotent on `(source_document_uuid, lower(trim(drug_name)))`.
 *
 * The intake form's free-text `dose` / `frequency` / `route` /
 * `notes` fields compose into a single free-text
 * `dosage_instructions` string. The PHP-side parser supplies sensible
 * defaults for `usage_category` and `request_intent` if the body
 * omits them, so the middleman can stay minimal here.
 */
const materializeMedicationStatementPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    // Both intake forms (patient-reported) and referral letters
    // (referring-provider-reported) carry `current_medications`. The
    // chart shape is identical — `MedicationStatement` either way.
    if (artifact.docType !== 'intake_form' && artifact.docType !== 'referral_letter') {
        return { error: 'fact_type_mismatch' };
    }
    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const medsRaw = schemaRecord['current_medications'];
    if (!Array.isArray(medsRaw) || medsRaw.length === 0) {
        return { error: 'schema_invalid' };
    }

    const fieldMatch = /^current_medications\.(\d+)/.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const idx = Number.parseInt(fieldMatch[1] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= medsRaw.length) {
        return { error: 'unsupported_field_path' };
    }

    const row: unknown = medsRaw[idx];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return { error: 'schema_invalid' };
    }
    const r = row as Record<string, unknown>;
    const name = r['name'];
    if (typeof name !== 'string' || name.trim() === '') {
        return { error: 'schema_invalid' };
    }

    // Compose dose / frequency / route / notes into a single
    // free-text dosage instructions string. The chart UI displays
    // `lists_medication.drug_dosage_instructions` verbatim, so this
    // matches what the patient wrote on the intake form (e.g.
    // "10mg once daily PO — patient reports good adherence").
    const parts: string[] = [];
    for (const key of ['dose', 'frequency', 'route', 'notes']) {
        const v = r[key];
        if (typeof v === 'string' && v.trim() !== '') {
            parts.push(v.trim());
        }
    }
    const dosageInstructions = parts.length > 0 ? parts.join(' ') : null;

    const body: Record<string, unknown> = {
        pid: artifact.pid,
        source_document_uuid: artifact.documentUuid,
        drug_name: name,
    };
    if (dosageInstructions !== null) {
        body['dosage_instructions'] = dosageInstructions;
    }
    return { body };
};

/**
 * Materialize the F.5e family-history promotion body from
 * `schemaJson` + `fieldPath`. The panel cites one
 * `family_history[<idx>]` entry from the intake-form schema;
 * F.5e's `?type=family_history` endpoint takes a single entry
 * (`pid`, `source_document_uuid`, `relation`, `condition`, optional
 * `comments`) — one accepted fact promotes one row, idempotent on
 * `(source_document_uuid, lower(trim("{relation} — {condition}")))`.
 *
 * `relation` and `condition` are passed through as separate fields
 * (rather than pre-composed into a `title`) so the PHP service owns
 * the canonical em-dash form. That keeps idempotency consistent
 * across re-promotes that vary only in whitespace or case.
 *
 * The intake-form schema has no `age_of_onset` field today, so the
 * middleman omits `onset_date`. The DTO accepts it as optional for
 * forward-compatibility once the schema gains the slot.
 */
const materializeFamilyHistoryPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    if (artifact.docType !== 'intake_form') {
        return { error: 'fact_type_mismatch' };
    }
    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const familyHistoryRaw = schemaRecord['family_history'];
    if (!Array.isArray(familyHistoryRaw) || familyHistoryRaw.length === 0) {
        return { error: 'schema_invalid' };
    }

    const fieldMatch = /^family_history\.(\d+)/.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const idx = Number.parseInt(fieldMatch[1] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= familyHistoryRaw.length) {
        return { error: 'unsupported_field_path' };
    }

    const row: unknown = familyHistoryRaw[idx];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return { error: 'schema_invalid' };
    }
    const r = row as Record<string, unknown>;
    const relation = r['relation'];
    const condition = r['condition'];
    if (typeof relation !== 'string' || relation.trim() === '') {
        return { error: 'schema_invalid' };
    }
    if (typeof condition !== 'string' || condition.trim() === '') {
        return { error: 'schema_invalid' };
    }

    const body: Record<string, unknown> = {
        pid: artifact.pid,
        source_document_uuid: artifact.documentUuid,
        relation,
        condition,
    };
    // The intake-form schema's only optional free-text slot today is
    // `notes`; map it to `comments` (the chart-side column) so the
    // family-history widget displays the agent's extracted context.
    if (typeof r['notes'] === 'string' && r['notes'].trim() !== '') {
        body['comments'] = r['notes'];
    }
    return { body };
};

/**
 * Materialize the F.5b allergy promotion body from `schemaJson` +
 * `fieldPath`. The panel cites one `allergies[<idx>]` entry from the
 * intake-form schema; F.5b's `?type=allergy` endpoint takes a single
 * allergy (`pid`, `source_document_uuid`, `substance`, optional
 * `reaction_option_id` / `verification_option_id` / `severity` /
 * `comments` / `onset_date`) — one accepted fact promotes one row,
 * idempotent on `(source_document_uuid, lower(trim(substance)))`.
 *
 * The intake form's free-text `reaction` and `severity` fields flow
 * straight through to the body. Mapping free text to OpenEMR's
 * `list_options` FK columns is deferred — the chart row carries the
 * agent-supplied text in `lists.reaction` / `severity_al` / etc.
 * directly, which the chart UI handles fine.
 */
const materializeAllergyPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    // Allergies show up on intake forms (patient self-report) and on
    // referral letters (referring provider's verified list). Both
    // map to the same `lists` allergy row shape.
    if (artifact.docType !== 'intake_form' && artifact.docType !== 'referral_letter') {
        return { error: 'fact_type_mismatch' };
    }
    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const allergiesRaw = schemaRecord['allergies'];
    if (!Array.isArray(allergiesRaw) || allergiesRaw.length === 0) {
        return { error: 'schema_invalid' };
    }

    const fieldMatch = /^allergies\.(\d+)/.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const idx = Number.parseInt(fieldMatch[1] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= allergiesRaw.length) {
        return { error: 'unsupported_field_path' };
    }

    // `allergiesRaw[idx]` is typed `any` because `allergiesRaw` is an
    // `unknown[]` from JSON.parse. Pin it to `unknown` first, then
    // narrow.
    const row: unknown = allergiesRaw[idx];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return { error: 'schema_invalid' };
    }
    const r = row as Record<string, unknown>;
    const substance = r['substance'];
    if (typeof substance !== 'string' || substance.trim() === '') {
        return { error: 'schema_invalid' };
    }

    const body: Record<string, unknown> = {
        pid: artifact.pid,
        source_document_uuid: artifact.documentUuid,
        substance,
    };
    if (typeof r['reaction'] === 'string' && r['reaction'].trim() !== '') {
        body['reaction_option_id'] = r['reaction'];
    }
    if (typeof r['severity'] === 'string' && r['severity'].trim() !== '') {
        body['severity'] = r['severity'];
    }
    return { body };
};

/**
 * Materialize the F.6 demographics promotion body from `schemaJson` +
 * `fieldPath`. The panel cites one cited slot under
 * `patient_demographics.{address|phone|email}` (the cited field's
 * `value` is the agent's free-text extraction). F.6's
 * `?type=demographics` endpoint takes one (field, value) pair per
 * call — single-field-per-click, idempotent on
 * compare-then-write of the matching `patient_data` column.
 *
 * Field path shape: the agent emits `patient_demographics.<name>`
 * (the panel `factType` is `'demographics'`, but each delta carries
 * its own field path so the materializer routes through the closed
 * `address|phone|email` enum). An off-list slot returns
 * `unsupported_field_path` so a future schema add doesn't silently
 * promote.
 *
 * The agent supplies `address` as a single free-text string (the
 * cited demographics envelope's `value`). The PHP-side service
 * writes it verbatim into `patient_data.street` per F.6's "free-text
 * pass-through" decision — see the {@see PatientDemographicsWriteService}
 * top-of-file comment for why we don't parse the line into structured
 * `city`/`state`/`postal_code` columns. Phone goes to
 * `patient_data.phone_cell`, email to `patient_data.email`.
 */
const DEMOGRAPHICS_FIELDS = ['address', 'phone', 'email'] as const;
type DemographicsFieldName = (typeof DEMOGRAPHICS_FIELDS)[number];

const isDemographicsField = (s: string): s is DemographicsFieldName =>
    (DEMOGRAPHICS_FIELDS as readonly string[]).includes(s);

const materializeDemographicsPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    // Both lab PDFs and intake forms can carry demographics deltas
    // (the lab header may contradict the chart). Either docType is
    // acceptable here — the schema lookup below pins the cited slot.
    if (artifact.docType !== 'intake_form' && artifact.docType !== 'lab_pdf') {
        return { error: 'fact_type_mismatch' };
    }
    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const demographicsRaw = schemaRecord['patient_demographics'];
    if (
        demographicsRaw === null
        || typeof demographicsRaw !== 'object'
        || Array.isArray(demographicsRaw)
    ) {
        return { error: 'schema_invalid' };
    }

    const fieldMatch = /^patient_demographics\.([A-Za-z_]+)/.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const fieldName = fieldMatch[1] ?? '';
    if (!isDemographicsField(fieldName)) {
        return { error: 'unsupported_field_path' };
    }

    const cited: unknown = (demographicsRaw as Record<string, unknown>)[fieldName];
    if (cited === null || typeof cited !== 'object' || Array.isArray(cited)) {
        return { error: 'schema_invalid' };
    }
    const value = (cited as Record<string, unknown>)['value'];
    if (typeof value !== 'string' || value.trim() === '') {
        return { error: 'schema_invalid' };
    }

    return {
        body: {
            pid: artifact.pid,
            source_document_uuid: artifact.documentUuid,
            field: fieldName,
            value,
        },
    };
};

export const createAcceptFactHandler = (
    deps: AcceptFactRouteDeps,
): ((c: Context) => Promise<Response>) => {
    const logger = createLogger('accept-fact-route');
    return async (c: Context): Promise<Response> => {
        const principal = getPrincipal(c);
        const token = getRawToken(c);
        const rawBody: unknown = await c.req.json().catch(() => null);
        const parsed = acceptFactRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            return c.json({ error: 'invalid_body' }, 400);
        }
        const { artifactId, fieldPath, factType, conversationId } = parsed.data;

        const artifact = await deps.store.findArtifactById(artifactId);
        if (artifact === null) {
            return c.json({ error: 'artifact_not_found' }, 404);
        }

        // Patient-match gate: the pipeline records
        // `patientMatchPartial = true` on the artifact's
        // confidenceSignal when the extracted demographics matched the
        // chart only loosely (name typo, off-by-one DOB). Tier-3
        // writes are too consequential to land on a partial match —
        // refuse with HTTP 409 and a typed error the panel surfaces
        // as "verify the patient identity before accepting." The
        // architecture's hard-stop posture treats partial-match as a
        // routing signal at retrieval time; this is the same signal
        // applied to writes.
        if (isPartialMatchArtifact(artifact)) {
            logger.warn(
                { artifactId, fieldPath, factType, principal: principal.sub },
                'accept_fact: refusing — artifact has partial patient match',
            );
            return c.json({ error: 'low_match_confidence' }, 409);
        }

        // Each materializer below is exhaustive over the closed
        // factType union and returns `Materialized` unconditionally,
        // so the post-switch narrowing works.
        const materialize = (
            type: typeof factType,
        ): Materialized => {
            switch (type) {
                case 'lab':
                    return materializeLabPromotionBody(artifact, fieldPath);
                case 'allergy':
                    return materializeAllergyPromotionBody(artifact, fieldPath);
                case 'medication_statement':
                    return materializeMedicationStatementPromotionBody(artifact, fieldPath);
                case 'past_medical_history':
                    return materializeMedicalProblemPromotionBody(artifact, fieldPath);
                case 'family_history':
                    return materializeFamilyHistoryPromotionBody(artifact, fieldPath);
                case 'demographics':
                    return materializeDemographicsPromotionBody(artifact, fieldPath);
            }
        };
        const materialized: Materialized = materialize(factType);
        if ('error' in materialized) {
            logger.warn(
                { artifactId, fieldPath, factType, reason: materialized.error },
                'accept_fact: failed to materialize promotion body',
            );
            return c.json({ error: materialized.error }, 400);
        }

        const promoteType: PromoteFactType = factType;
        let promoteResult;
        try {
            promoteResult = await deps.promoteClient.promote({
                type: promoteType,
                body: materialized.body,
                token,
                siteId: principal.siteId,
                ...(conversationId !== undefined ? { conversationId } : {}),
            });
        } catch (err) {
            if (err instanceof PromoteHttpError) {
                logger.warn(
                    {
                        artifactId,
                        fieldPath,
                        promoteStatus: err.status,
                        promoteError: err.errorCode,
                    },
                    'accept_fact: promote.php returned non-2xx',
                );
                // Surface 501 as 501 (so the panel can render the
                // "type not yet implemented" toast directly without
                // mapping). Other 4xx/5xx fold into the catch-all
                // typed envelope.
                if (err.status === 501) {
                    return c.json({ error: 'not_yet_implemented' }, 501);
                }
                return c.json({ error: 'promote_failed', status: err.status }, 502);
            }
            if (err instanceof PromoteNetworkError) {
                logger.error(
                    { err, artifactId, fieldPath },
                    'accept_fact: promote.php unreachable',
                );
                return c.json({ error: 'promote_unreachable' }, 502);
            }
            if (err instanceof PromoteMalformedResponseError) {
                logger.error(
                    { err, artifactId, fieldPath },
                    'accept_fact: promote.php malformed response',
                );
                return c.json({ error: 'promote_malformed' }, 502);
            }
            throw err;
        }

        // Chart row landed. Now record the per-fact disposition. A
        // failure here is logged but does not roll back the chart
        // write — `promote.php`'s idempotency key means re-firing
        // accept on the same fact returns the existing chart record
        // without a duplicate row, so the disposition can be
        // reconciled later.
        let dispositionResult;
        try {
            dispositionResult = await deps.store.recordDisposition({
                artifactId,
                fieldPath,
                status: 'accepted',
                userId: principal.sub,
            });
        } catch (err) {
            logger.error(
                { err, artifactId, fieldPath, actor: principal.sub },
                'accept_fact: recordDisposition threw — chart row already persisted',
            );
            return c.json({
                chartRecordUuid: promoteResult.chartRecordUuid,
                chartRecordType: promoteResult.chartRecordType,
                observationUuids: promoteResult.observationUuids,
                idempotentHit: promoteResult.idempotentHit,
                dispositionRolledTo: null,
                dispositionWriteFailed: true,
            });
        }

        return c.json({
            chartRecordUuid: promoteResult.chartRecordUuid,
            chartRecordType: promoteResult.chartRecordType,
            observationUuids: promoteResult.observationUuids,
            idempotentHit: promoteResult.idempotentHit,
            dispositionRolledTo: dispositionResult.artifactStatusRolledTo,
        });
    };
};
