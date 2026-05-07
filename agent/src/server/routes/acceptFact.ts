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
 * Materialize the F.2 lab promotion body from `schemaJson` +
 * `fieldPath`. The panel cites a single `results[<idx>]` entry from
 * the lab schema, but the F.2 promote endpoint takes a whole panel
 * (`pid`, `source_document_uuid`, `panel_code`, `collection_date`,
 * `results: [...]`). So one accepted fact promotes the whole panel:
 * the F.2 idempotency key (`source_document_uuid`, `panel_code`,
 * `collection_date`) ensures a re-promote of a different fact on the
 * same panel returns the existing IDs without writing a duplicate row.
 */
const materializeLabPromotionBody = (
    artifact: ExtractionArtifact,
    fieldPath: string,
): Materialized => {
    if (artifact.docType !== 'lab_pdf') {
        return { error: 'fact_type_mismatch' };
    }
    const schema = artifact.schemaJson;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { error: 'schema_invalid' };
    }
    const schemaRecord = schema as Record<string, unknown>;
    const resultsRaw = schemaRecord['results'];
    if (!Array.isArray(resultsRaw) || resultsRaw.length === 0) {
        return { error: 'schema_invalid' };
    }

    // The fieldPath the panel cites is `results.<n>`. We don't need it
    // for the body shape (F.2 takes the whole results array), but
    // validating it points into a real result keeps the panel from
    // promoting a phantom row the verifier would have rejected.
    const fieldMatch = /^results\.(\d+)/.exec(fieldPath);
    if (fieldMatch === null) {
        return { error: 'unsupported_field_path' };
    }
    const idx = Number.parseInt(fieldMatch[1] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= resultsRaw.length) {
        return { error: 'unsupported_field_path' };
    }

    // Per-result rows. The lab schema marks every column except panel_code,
    // ref_range_*, and abnormal_flag as required, so missing-required is a
    // schema-drift bug not a normal path — surface as `schema_invalid`.
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
            || typeof collectionDateRow !== 'string'
        ) {
            return { error: 'schema_invalid' };
        }
        collectionDate ??= collectionDateRow;
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
        return { error: 'schema_invalid' };
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
    if (artifact.docType !== 'intake_form') {
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

        // F.5a shipped the lab materializer; F.5b ships allergy. The
        // remaining three list-shaped fact types stay 501 here so the
        // panel surfaces the same typed-error toast it would for a
        // direct `promote.php?type=…` call. F.5c–F.5e flip them.
        let materialized: Materialized;
        if (factType === 'lab') {
            materialized = materializeLabPromotionBody(artifact, fieldPath);
        } else if (factType === 'allergy') {
            materialized = materializeAllergyPromotionBody(artifact, fieldPath);
        } else {
            return c.json({ error: 'not_yet_implemented' }, 501);
        }
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
