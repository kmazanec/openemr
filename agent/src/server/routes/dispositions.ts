/**
 * F.5a `POST /v1/agent/dispositions` — record a clinician's per-fact
 * accept/reject decision against an extracted artifact.
 *
 * The panel UI calls this route in two cases:
 *  - **Accept** — after `promote.php` (PHP-side Tier-3 chart write)
 *    returns 200, the panel posts here with `status='accepted'` so the
 *    agent's `extracted_fact_dispositions` table reflects the same
 *    state. The chart row is the source of truth for the data; the
 *    disposition row is the source of truth for "did the clinician
 *    say yes."
 *  - **Reject** — direct call with `status='rejected'`. No chart
 *    write happens; the disposition row is the only side effect.
 *
 * The `recordDisposition` helper is idempotent on
 * `(artifact_id, field_path)` and refuses to overwrite an
 * already-non-pending row, so re-firing the route on a network retry
 * is safe.
 *
 * Auth surface mirrors every other `/v1/agent/*` route — the bearer
 * middleware has already verified the JWT before the handler runs.
 */

import type { Context } from 'hono';
import { z } from 'zod';

import { getPrincipal } from '../../auth/middleware.js';
import { createLogger } from '../../observability/logger.js';
import type { ExtractionArtifactStore } from '../../state/extractionArtifacts.js';

const dispositionRequestSchema = z.object({
    artifactId: z.string().min(1).max(200),
    fieldPath: z.string().min(1).max(500),
    status: z.union([z.literal('accepted'), z.literal('rejected')]),
});

export interface DispositionsRouteDeps {
    readonly store: Pick<ExtractionArtifactStore, 'recordDisposition'>;
}

export const createDispositionsHandler = (
    deps: DispositionsRouteDeps,
): ((c: Context) => Promise<Response>) => {
    const logger = createLogger('dispositions-route');
    return async (c: Context): Promise<Response> => {
        const principal = getPrincipal(c);
        const rawBody: unknown = await c.req.json().catch(() => null);
        const parsed = dispositionRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            return c.json({ error: 'invalid_body' }, 400);
        }

        const { artifactId, fieldPath, status } = parsed.data;
        try {
            const result = await deps.store.recordDisposition({
                artifactId,
                fieldPath,
                status,
                userId: principal.sub,
            });
            return c.json({
                disposition: {
                    artifactId: result.disposition.artifactId,
                    fieldPath: result.disposition.fieldPath,
                    status: result.disposition.status,
                    acceptedAt: result.disposition.acceptedAt,
                },
                artifactStatusRolledTo: result.artifactStatusRolledTo,
            });
        } catch (err) {
            logger.error(
                {
                    err,
                    artifactId,
                    fieldPath,
                    status,
                    actor: principal.sub,
                },
                'recordDisposition threw',
            );
            return c.json({ error: 'disposition_failed' }, 500);
        }
    };
};
