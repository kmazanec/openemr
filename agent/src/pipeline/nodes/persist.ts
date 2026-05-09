/**
 * §B.7 Pipeline node 5 — `persist`.
 *
 * Atomic Tier-1 + Tier-2 write per `W2_ARCHITECTURE.md` §"Persistence
 * (Tier 1 + Tier 2)":
 *
 *   1. Compute `document_hash` (SHA-256 of canonical bytes).
 *   2. Idempotency lookup: if a row already exists for
 *      `(document_hash, EXTRACTOR_VERSION, pid)`, short-circuit with the
 *      cached `artifact_id`. The cached row's deltas are *not*
 *      recomputed — re-running the same input is by definition a
 *      no-op. `pid` is in the key so the same bytes uploaded under two
 *      different patients produce two artifacts, not one — without it,
 *      a cross-patient re-upload silently aliased to the first patient's
 *      row.
 *   3. Otherwise, claim an advisory lock on `document_uuid` (so two
 *      concurrent invokers serialize through one writer).
 *   4. Call OpenEMR's Tier-1 endpoint to write the DocumentReference.
 *      The endpoint returns a canonical UUID — *that* becomes the
 *      `extraction_artifacts.document_uuid` we record in Tier 2,
 *      replacing the placeholder uuid the pipeline carried for the
 *      pre-persist phase. (The placeholder is what `rasterize` /
 *      `vision` keyed off; it stays meaningful for trace metadata.)
 *   5. Insert the Tier-2 row with the full schema, `confidenceSignal`
 *      from `patientMatch`, status `pending_confirmation`, and a
 *      `null` `deltasJson` slot — `emitDeltas` (B.7's emitDeltas node)
 *      fills that in immediately downstream and updates the row in
 *      place.
 *   6. Release the lock.
 *
 * Failure isolation per `W2_ARCHITECTURE.md` §"Failure isolation": a
 * Tier-1 endpoint outage or DB write failure produces a `persist_failed`
 * pipeline error and `status='failed'` on the artifact (no row is
 * written when the OpenEMR call fails — there's nothing to attach the
 * extraction to). A `failed` upstream short-circuits this node entirely
 * so we never attempt to persist a refused extraction.
 */

import { createHash } from 'node:crypto';

import type { Logger } from 'pino';

import {
    type ExtractionArtifactStore,
    type DocumentLockHandle,
    type ExtractionArtifact,
} from '../../state/extractionArtifacts.js';
import {
    DocumentReferenceHttpError,
    DocumentReferenceMalformedResponseError,
    DocumentReferenceNetworkError,
    type OpenEmrDocumentReferenceClient,
} from '../../storage/openemrDocumentReferenceClient.js';
import { keyForCanonical, type SpacesClient } from '../../storage/spaces.js';
import { EXTRACTOR_VERSION } from './vision.js';
import { type PipelineError, type PipelineState } from '../state.js';

export interface PersistDeps {
    readonly artifactStore: ExtractionArtifactStore;
    readonly openemrSpaces: SpacesClient;
    readonly documentReferenceClient: OpenEmrDocumentReferenceClient;
    readonly logger: Logger;
    readonly artifactIdGenerator: () => string;
    /**
     * The file extension of the canonical object as stored in Spaces.
     * Same value `rasterize` keyed off — used here to resolve the
     * Spaces key when re-reading the canonical bytes for hashing.
     */
    readonly canonicalExt: string;
    /**
     * Per-call OpenEMR JWT (the agent threads inbound tokens to its
     * outbound callbacks) and site id. Both come from the supervisor's
     * `kickoffExtraction` envelope (§B.9 wires them in).
     */
    readonly openemrToken: string;
    readonly openemrSiteId: string;
    /**
     * Conversation id is forwarded so the disclosure event the Tier-1
     * endpoint dispatches carries it for compliance auditing. Optional
     * because non-conversational invokers (autosweep, CLI replay) have
     * no conversation context.
     */
    readonly conversationId?: string;
}

const fail = (state: PipelineState, error: PipelineError): Partial<PipelineState> => ({
    status: 'failed',
    errors: [...state.errors, error],
});

const sha256Hex = (bytes: Buffer): string =>
    createHash('sha256').update(bytes).digest('hex');

export const persist = async (
    state: PipelineState,
    deps: PersistDeps,
): Promise<Partial<PipelineState>> => {
    if (state.status === 'failed') {
        // Upstream node already refused. Don't write a Tier-1/Tier-2
        // pair for an extraction that was never produced.
        return {};
    }

    if (state.schema === null) {
        deps.logger.error(
            { documentUuid: state.documentUuid, pid: state.pid },
            'persist: schema is null but status is not failed; refusing to write',
        );
        return fail(state, {
            code: 'persist_failed',
            message: 'persist: extraction schema is null',
        });
    }

    const { artifactStore, openemrSpaces, documentReferenceClient, logger } = deps;
    const placeholderUuid = state.documentUuid;
    const canonicalKey = keyForCanonical(state.pid, placeholderUuid, deps.canonicalExt);

    let canonicalBytes: Buffer;
    try {
        const obj = await openemrSpaces.getObject({ key: canonicalKey });
        canonicalBytes = obj.body;
    } catch (err) {
        logger.error(
            { documentUuid: placeholderUuid, canonicalKey, err: String(err) },
            'persist: failed to re-read canonical bytes for hashing',
        );
        return fail(state, {
            code: 'storage-unreachable',
            message: 'persist: unable to read canonical bytes for hashing',
        });
    }

    const documentHash = sha256Hex(canonicalBytes);

    let cached: ExtractionArtifact | null;
    try {
        cached = await artifactStore.findArtifactByDocumentHash(
            documentHash,
            EXTRACTOR_VERSION,
            state.pid,
        );
    } catch (err) {
        logger.error(
            { documentUuid: placeholderUuid, err: String(err) },
            'persist: idempotency lookup failed',
        );
        return fail(state, {
            code: 'persist_failed',
            message: 'persist: idempotency lookup failed',
        });
    }

    if (cached !== null) {
        logger.info(
            {
                documentUuid: cached.documentUuid,
                artifactId: cached.artifactId,
                placeholderUuid,
                pid: state.pid,
            },
            'persist: idempotency hit — returning cached artifact',
        );
        return {
            artifactId: cached.artifactId,
            documentUuid: cached.documentUuid,
            status: 'persisted',
        };
    }

    let lock: DocumentLockHandle;
    try {
        lock = await artifactStore.claimDocumentLock(placeholderUuid);
    } catch (err) {
        logger.error(
            { documentUuid: placeholderUuid, err: String(err) },
            'persist: failed to claim advisory lock',
        );
        return fail(state, {
            code: 'persist_failed',
            message: 'persist: unable to claim document lock',
        });
    }

    try {
        // Re-check inside the lock — between the first `findArtifactByDocumentHash`
        // and the `claimDocumentLock` a concurrent invoker may have raced
        // ahead and persisted. Without the re-read we'd hit the UNIQUE
        // constraint and crash; with it we short-circuit the same way the
        // pre-lock path does.
        let cachedAfterLock: ExtractionArtifact | null;
        try {
            cachedAfterLock = await artifactStore.findArtifactByDocumentHash(
                documentHash,
                EXTRACTOR_VERSION,
                state.pid,
            );
        } catch (err) {
            logger.error(
                { documentUuid: placeholderUuid, err: String(err) },
                'persist: idempotency re-check failed under lock',
            );
            return fail(state, {
                code: 'persist_failed',
                message: 'persist: idempotency re-check failed',
            });
        }
        if (cachedAfterLock !== null) {
            logger.info(
                {
                    documentUuid: cachedAfterLock.documentUuid,
                    artifactId: cachedAfterLock.artifactId,
                    placeholderUuid,
                },
                'persist: race-lost idempotency hit under lock',
            );
            return {
                artifactId: cachedAfterLock.artifactId,
                documentUuid: cachedAfterLock.documentUuid,
                status: 'persisted',
            };
        }

        let canonicalUuid: string;
        try {
            const result = await documentReferenceClient.writeDocumentReference({
                pid: state.pid,
                docType: state.docType,
                documentUuid: placeholderUuid,
                token: deps.openemrToken,
                siteId: deps.openemrSiteId,
                ...(deps.conversationId !== undefined ? { conversationId: deps.conversationId } : {}),
            });
            canonicalUuid = result.documentUuid;
        } catch (err) {
            const code: PipelineError['code'] = err instanceof DocumentReferenceNetworkError
                ? 'storage-unreachable'
                : 'persist_failed';
            const message = err instanceof DocumentReferenceHttpError
                ? `Tier-1 endpoint refused: HTTP ${err.status}`
                : err instanceof DocumentReferenceMalformedResponseError
                    ? 'Tier-1 endpoint returned malformed body'
                    : err instanceof DocumentReferenceNetworkError
                        ? 'Tier-1 endpoint unreachable'
                        : 'Tier-1 endpoint failed';
            logger.error(
                { documentUuid: placeholderUuid, pid: state.pid, code, err: String(err) },
                'persist: Tier-1 DocumentReference write failed',
            );
            return fail(state, { code, message });
        }

        const artifactId = deps.artifactIdGenerator();
        let inserted: ExtractionArtifact;
        try {
            inserted = await artifactStore.insertArtifact({
                artifactId,
                documentUuid: canonicalUuid,
                pid: state.pid,
                docType: state.docType,
                extractorVersion: EXTRACTOR_VERSION,
                schemaJson: state.schema,
                deltasJson: null,
                confidenceSignal: state.confidenceSignal,
                status: 'pending_confirmation',
                documentHash,
            });
        } catch (err) {
            logger.error(
                { documentUuid: placeholderUuid, canonicalUuid, err: String(err) },
                'persist: Tier-2 insert failed',
            );
            return fail(state, {
                code: 'persist_failed',
                message: 'persist: Tier-2 insert failed',
            });
        }

        logger.info(
            {
                documentUuid: canonicalUuid,
                artifactId: inserted.artifactId,
                pid: state.pid,
                docType: state.docType,
            },
            'persist: Tier-1 + Tier-2 written',
        );
        return {
            artifactId: inserted.artifactId,
            documentUuid: inserted.documentUuid,
            status: 'persisted',
        };
    } finally {
        try {
            await lock.release();
        } catch (err) {
            logger.warn(
                { documentUuid: placeholderUuid, err: String(err) },
                'persist: advisory lock release failed (connection-close backstop)',
            );
        }
    }
};
