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

export interface ScheduleBriefingDayKey {
    readonly practitionerUuid: string;
    readonly dateUtc: string;
}

export interface ScheduleBriefingSummary {
    readonly appointmentId: string;
    readonly flags: readonly string[];
    readonly generatedAt: string;
}

export interface ScheduleBriefingsLog {
    readonly existsForToday: (key: ScheduleBriefingKey, today: string) => Promise<boolean>;
    readonly record: (
        record: ScheduleBriefingRecord,
        options: { readonly force: boolean },
    ) => Promise<RecordOutcome>;
    /**
     * §5.4 read path. Returns the cached briefings for a (practitioner,
     * day) pair as compact `appointment_id → flags` summaries — no
     * `summary` payload, since the schedule view only renders the flag
     * chips, and the panel re-runs UC1 on click-through. `dateUtc` is a
     * `YYYY-MM-DD` string in UTC (the same key used by the UNIQUE
     * index). An empty list (vs. an error) is the disabled-default
     * story; callers degrade gracefully when the cache is cold.
     */
    readonly listForPractitionerDay: (
        key: ScheduleBriefingDayKey,
    ) => Promise<readonly ScheduleBriefingSummary[]>;
}

// Schema lives in `agent/migrations/1700000005000_baseline_schedule_briefings.sql`.

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

const LIST_FOR_DAY_SQL = `
    SELECT appointment_id, flags, generated_at
    FROM schedule_briefings
    WHERE practitioner_uuid = $1
      AND ((generated_at AT TIME ZONE 'UTC')::date) = $2::date
    ORDER BY generated_at ASC
`;

export interface PgScheduleBriefingsLogOptions {
    readonly connectionString: string;
}

/**
 * Postgres-backed sink. Mirrors {@link createPgUnverifiedClaimsLog} —
 * `pg.Pool` shared with the rest of the agent's state-store workload.
 * Schema is provisioned at boot by the migrations runner; this module
 * never issues DDL.
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

    const listForPractitionerDay = async (
        key: ScheduleBriefingDayKey,
    ): Promise<readonly ScheduleBriefingSummary[]> => {
        const result = await pool.query(LIST_FOR_DAY_SQL, [
            key.practitionerUuid,
            key.dateUtc,
        ]);
        return result.rows.map((row): ScheduleBriefingSummary => {
            const rawFlags = row['flags'];
            const flags: readonly string[] = Array.isArray(rawFlags)
                ? rawFlags.filter((f): f is string => typeof f === 'string')
                : [];
            const rawAppointmentId = row['appointment_id'];
            const rawGeneratedAt = row['generated_at'];
            return {
                appointmentId: typeof rawAppointmentId === 'string' ? rawAppointmentId : '',
                flags,
                generatedAt:
                    rawGeneratedAt instanceof Date
                        ? rawGeneratedAt.toISOString()
                        : typeof rawGeneratedAt === 'string'
                          ? rawGeneratedAt
                          : '',
            };
        });
    };

    return { existsForToday, record, listForPractitionerDay };
};

/**
 * No-op sink for tests and for boot paths where the agent is configured
 * without the schedule-briefings store (e.g. an in-memory CI run that
 * never exercises the precompute path). Mirrors
 * {@link createNullUnverifiedClaimsLog}.
 */
export const createNullScheduleBriefingsLog = (): ScheduleBriefingsLog => ({
    existsForToday: () => Promise.resolve(false),
    record: () => Promise.resolve({ written: true, outcome: 'inserted' }),
    listForPractitionerDay: () => Promise.resolve([]),
});
