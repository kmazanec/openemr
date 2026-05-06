import pg from 'pg';

import { createLogger } from '../observability/logger.js';
import type { Claim } from '../graph/types.js';

/**
 * §3.3 last checkbox: "Unverified claims logged in full to a separate
 * Postgres table for debugging, with retention TBD." This is the
 * engineering-instrumentation sink the verifier writes every dropped
 * claim to. It is *not* the regulatory disclosure trail (that lives in
 * OpenEMR's `extended_log` per §2.4) and it is not the LangGraph
 * checkpointer (that's covered by the Postgres saver from §1.2).
 *
 * Records carry the claim text and source references in full so a
 * future contributor debugging "why was this rejected" can replay the
 * verifier's decision. Retention is TBD — the README will note the
 * decision deadline once a policy is set.
 */

export interface UnverifiedClaimContext {
    readonly requestId: string;
    readonly conversationId: string;
}

export interface UnverifiedClaimRecord {
    readonly context: UnverifiedClaimContext;
    readonly claim: Claim;
    readonly reason: string;
}

export interface UnverifiedClaimsLog {
    readonly record: (entries: readonly UnverifiedClaimRecord[]) => Promise<void>;
}

const INSERT_SQL = `
    INSERT INTO unverified_claims (
        request_id, conversation_id, claim_id, claim_text, claim_category,
        source_references, rejection_reason, safety_critical
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

export interface PgUnverifiedClaimsLogOptions {
    readonly connectionString: string;
}

/**
 * Postgres-backed sink. Writes use a shared `pg.Pool` so successive
 * verifier runs share the connection budget with the rest of the agent
 * Postgres workload (the LangGraph saver runs its own pool today; we
 * could merge them in §3.5 if pool contention becomes a problem).
 */
export const createPgUnverifiedClaimsLog = (
    options: PgUnverifiedClaimsLogOptions,
): UnverifiedClaimsLog => {
    if (options.connectionString.trim().length === 0) {
        throw new Error('Postgres connection string is required for unverified-claims log');
    }
    const pool = new pg.Pool({ connectionString: options.connectionString });
    const logger = createLogger('unverifiedClaimsLog');

    const record = async (entries: readonly UnverifiedClaimRecord[]): Promise<void> => {
        if (entries.length === 0) return;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const entry of entries) {
                await client.query(INSERT_SQL, [
                    entry.context.requestId,
                    entry.context.conversationId,
                    entry.claim.id,
                    entry.claim.text,
                    entry.claim.category,
                    JSON.stringify(entry.claim.sourceReferences),
                    entry.reason,
                    entry.claim.safetyCritical,
                ]);
            }
            await client.query('COMMIT');
        } catch (err: unknown) {
            await client.query('ROLLBACK');
            // Engineering instrumentation: a write failure here must not
            // block the response. We log and swallow. The dropped claim
            // is still surfaced to the caller through `verified.rejected`.
            logger.error(
                { err, count: entries.length },
                'failed to record unverified claims; rolling back batch',
            );
        } finally {
            client.release();
        }
    };

    return { record };
};

/**
 * No-op sink for tests and for boot paths where the agent is configured
 * without the unverified-claims store (e.g. the in-memory CI run).
 */
export const createNullUnverifiedClaimsLog = (): UnverifiedClaimsLog => ({
    record: () => Promise.resolve(),
});
