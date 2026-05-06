/**
 * §B.7 Pipeline EXIT — `cleanup`.
 *
 * Delete the transient page PNGs the `rasterize` node uploaded so the
 * Spaces transient prefix doesn't accumulate orphaned objects. The 24h
 * lifecycle policy (`W2_ARCHITECTURE.md` §"DigitalOcean Spaces") is
 * the backstop — this node is the fast path.
 *
 * Two invariants:
 *
 *   1. Only delete keys that live under the configured transient
 *      prefix. The image-passthrough path (rasterize for PNG/JPEG/TIFF
 *      canonical objects) lists the canonical key as a single
 *      "page" — that key is *not* under the transient prefix, and
 *      deleting it would destroy the canonical bytes the Tier-1
 *      DocumentReference points at. We guard with a string-prefix
 *      check.
 *
 *   2. Cleanup never fails the pipeline. A failure to delete a
 *      transient is logged and the lifecycle policy mops it up; we
 *      preserve the upstream `status` (`persisted` or `failed`) so
 *      the EXIT-edge state still represents the real outcome.
 */

import type { Logger } from 'pino';

import { type SpacesClient } from '../../storage/spaces.js';
import { type PipelineState } from '../state.js';

export interface CleanupDeps {
    readonly openemrSpaces: SpacesClient;
    readonly transientPrefix: string;
    readonly logger: Logger;
}

const isUnderTransientPrefix = (key: string, prefix: string): boolean => {
    const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return key === trimmed || key.startsWith(`${trimmed}/`);
};

export const cleanup = async (
    state: PipelineState,
    deps: CleanupDeps,
): Promise<Partial<PipelineState>> => {
    const transientKeys = state.pages
        .map((p) => p.key)
        .filter((key) => isUnderTransientPrefix(key, deps.transientPrefix));

    if (transientKeys.length === 0) {
        return {};
    }

    let succeeded = 0;
    let failed = 0;
    for (const key of transientKeys) {
        try {
            await deps.openemrSpaces.deleteObject({ key });
            succeeded += 1;
        } catch (err) {
            failed += 1;
            deps.logger.warn(
                { documentUuid: state.documentUuid, key, err: String(err) },
                'cleanup: failed to delete transient object (24h lifecycle is backstop)',
            );
        }
    }

    deps.logger.info(
        {
            documentUuid: state.documentUuid,
            succeeded,
            failed,
            total: transientKeys.length,
        },
        'cleanup: transient objects deleted',
    );

    return {};
};
