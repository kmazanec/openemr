import pg from 'pg';

import type { AssistantMessage } from '../graph/types.js';
import { createLogger } from '../observability/logger.js';

/**
 * §5.3 morning-prep cache. One row per `(practitioner, appointment, day)`
 * pre-computed by the `agent:precompute-day` CLI so the schedule view can
 * render instantly when the practitioner opens it for the first time.
 *
 * The table is *not* the conversation store: a precompute run produces a
 * cached briefing for a slot the clinician hasn't necessarily opened yet,
 * and the row's lifetime is one calendar day rather than the rolling
 * conversation window. The two paths share the underlying UC1 graph but
 * diverge at the persistence sink — precompute writes here, interactive
 * default-briefing writes to `conversations` + `conversation_messages`.
 *
 * Idempotency lives in this module: callers ask `existsForToday()` before
 * spending tokens, and the UNIQUE index is the floor against concurrent
 * writers. `force` does a delete-then-insert in a single transaction so a
 * debug rerun cleanly overwrites the cached row.
 */

export interface ScheduleBriefingKey {
    readonly practitionerUuid: string;
    readonly appointmentId: string;
}

export interface ScheduleBriefingRecord {
    readonly key: ScheduleBriefingKey;
    readonly summary: AssistantMessage;
    readonly flags: readonly string[];
    readonly requestId: string;
}

export interface RecordOutcome {
    readonly written: boolean;
    /**
     * `'inserted'` — a new row was written.
     * `'overwritten'` — `force` was set and the previous row was replaced.
     * `'skipped_idempotent'` — UNIQUE conflict; another writer landed first
     *                          (or the orchestrator's pre-check missed a race).
     */
    readonly outcome: 'inserted' | 'overwritten' | 'skipped_idempotent';
}

export interface ScheduleBriefingsLog {
    readonly setup: () => Promise<void>;
    readonly existsForToday: (key: ScheduleBriefingKey, today: string) => Promise<boolean>;
    readonly record: (
        record: ScheduleBriefingRecord,
        options: { readonly force: boolean },
    ) => Promise<RecordOutcome>;
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS schedule_briefings (
        id BIGSERIAL PRIMARY KEY,
        practitioner_uuid TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        summary JSONB NOT NULL,
        flags JSONB NOT NULL,
        request_id TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS schedule_briefings_unique
        ON schedule_briefings (
            practitioner_uuid,
            appointment_id,
            ((generated_at AT TIME ZONE 'UTC')::date)
        );
    CREATE INDEX IF NOT EXISTS schedule_briefings_practitioner_idx
        ON schedule_briefings (practitioner_uuid, generated_at);
`;

const EXISTS_SQL = `
    SELECT 1 FROM schedule_briefings
    WHERE practitioner_uuid = $1
      AND appointment_id = $2
      AND ((generated_at AT TIME ZONE 'UTC')::date) = $3::date
    LIMIT 1
`;

const DELETE_FOR_TODAY_SQL = `
    DELETE FROM schedule_briefings
    WHERE practitioner_uuid = $1
      AND appointment_id = $2
      AND ((generated_at AT TIME ZONE 'UTC')::date) = (now() AT TIME ZONE 'UTC')::date
`;

const INSERT_SQL = `
    INSERT INTO schedule_briefings (
        practitioner_uuid, appointment_id, summary, flags, request_id
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING
    RETURNING id
`;

export interface PgScheduleBriefingsLogOptions {
    readonly connectionString: string;
}

/**
 * Postgres-backed sink. Mirrors {@link createPgUnverifiedClaimsLog} —
 * `pg.Pool` shared with the rest of the agent's state-store workload,
 * raw SQL, no migrations.
 */
export const createPgScheduleBriefingsLog = (
    options: PgScheduleBriefingsLogOptions,
): ScheduleBriefingsLog => {
    if (options.connectionString.trim().length === 0) {
        throw new Error('Postgres connection string is required for schedule-briefings log');
    }
    const pool = new pg.Pool({ connectionString: options.connectionString });
    return createScheduleBriefingsLogFromPool(pool);
};

/**
 * The minimum surface this module needs from a `pg.Pool`. Carved out so
 * tests can pass a Vitest-`fn` fake — typing it as `Pick<pg.Pool, …>`
 * collides with `pg.Pool`'s overloaded `query` signature and forces
 * tests into casts.
 */
export interface PoolLike {
    readonly query: (sql: string, params?: readonly unknown[]) => Promise<{
        readonly rowCount: number | null;
        readonly rows: readonly Record<string, unknown>[];
    }>;
    readonly connect: () => Promise<{
        readonly query: (sql: string, params?: readonly unknown[]) => Promise<{
            readonly rowCount: number | null;
            readonly rows: readonly Record<string, unknown>[];
        }>;
        readonly release: () => void;
    }>;
}

/**
 * Pool-injectable factory so tests can drive the SQL surface against a
 * fake pool (or a future pg-mem harness) without booting Postgres.
 * Production code uses {@link createPgScheduleBriefingsLog}.
 */
export const createScheduleBriefingsLogFromPool = (
    pool: PoolLike,
): ScheduleBriefingsLog => {
    const logger = createLogger('scheduleBriefingsLog');

    const setup = async (): Promise<void> => {
        await pool.query(SCHEMA_SQL);
    };

    const existsForToday = async (
        key: ScheduleBriefingKey,
        today: string,
    ): Promise<boolean> => {
        const result = await pool.query(EXISTS_SQL, [
            key.practitionerUuid,
            key.appointmentId,
            today,
        ]);
        return result.rowCount !== null && result.rowCount > 0;
    };

    const record = async (
        entry: ScheduleBriefingRecord,
        options: { readonly force: boolean },
    ): Promise<RecordOutcome> => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            let overwritten = false;
            if (options.force) {
                const deleteResult = await client.query(DELETE_FOR_TODAY_SQL, [
                    entry.key.practitionerUuid,
                    entry.key.appointmentId,
                ]);
                overwritten = (deleteResult.rowCount ?? 0) > 0;
            }
            const insertResult = await client.query(INSERT_SQL, [
                entry.key.practitionerUuid,
                entry.key.appointmentId,
                JSON.stringify(entry.summary),
                JSON.stringify(entry.flags),
                entry.requestId,
            ]);
            await client.query('COMMIT');
            const inserted = (insertResult.rowCount ?? 0) > 0;
            if (!inserted) {
                return { written: false, outcome: 'skipped_idempotent' };
            }
            return {
                written: true,
                outcome: overwritten ? 'overwritten' : 'inserted',
            };
        } catch (err: unknown) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // ROLLBACK after a connection-level failure can itself
                // throw — swallowing keeps the original error in the
                // logger.error below where it's actionable.
            }
            logger.error(
                { err, practitionerUuid: entry.key.practitionerUuid, appointmentId: entry.key.appointmentId },
                'failed to record schedule briefing',
            );
            throw err;
        } finally {
            client.release();
        }
    };

    return { setup, existsForToday, record };
};

/**
 * No-op sink for tests and for boot paths where the agent is configured
 * without the schedule-briefings store (e.g. an in-memory CI run that
 * never exercises the precompute path). Mirrors
 * {@link createNullUnverifiedClaimsLog}.
 */
export const createNullScheduleBriefingsLog = (): ScheduleBriefingsLog => ({
    setup: () => Promise.resolve(),
    existsForToday: () => Promise.resolve(false),
    record: () => Promise.resolve({ written: true, outcome: 'inserted' }),
});
