import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { createLogger } from '../observability/logger.js';

/**
 * §3.5 conversation persistence, with §4.6 resume support layered on top.
 *
 * A conversation is the thread of briefing turns a clinician has with the
 * agent for a specific patient. We never dedupe and never overwrite — every
 * cold start mints a fresh row, so the historical conversation log is
 * monotonic and a future conversation-history UI can read it in full.
 *
 * Resume scope: when a clinician opens the chart, we look up the most
 * recent conversation for `(user_id, patient_pid)` and return it iff the
 * row's `updated_at` is within a configurable window (12h today). Activity
 * — and only activity, in the message-persisted sense — bumps `updated_at`.
 * `appointment_id` is stored for future faceting but does NOT participate
 * in the resume key; chart-opens and appointment-opens share the same
 * thread within the window.
 */

export interface ConversationKey {
    readonly userId: string;
    readonly patientPid: number;
    readonly appointmentId: string | null;
}

export interface ConversationRecord {
    readonly id: string;
    readonly userId: string;
    readonly patientPid: number;
    readonly appointmentId: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface ResumableConversation {
    readonly id: string;
    readonly updatedAt: string;
}

export interface ConversationStore {
    readonly setup: () => Promise<void>;
    /**
     * Mint a fresh row. Always inserts; the caller is responsible for
     * deciding whether to mint or to resume an existing conversation.
     */
    readonly create: (key: ConversationKey) => Promise<ConversationRecord>;
    /**
     * Most recent conversation for `(userId, patientPid)` whose
     * `updated_at` is within `withinHours` of `now`. Returns `null`
     * when no such row exists. Older conversations stay on disk but
     * are not surfaced for resume.
     */
    readonly findResumable: (
        userId: string,
        patientPid: number,
        withinHours: number,
    ) => Promise<ResumableConversation | null>;
    /**
     * Bump `updated_at = now()` for the given conversation. Called from
     * the persistence path on every appended message; pure tab opens
     * should NOT touch the timestamp.
     */
    readonly touch: (conversationId: string) => Promise<void>;
    /**
     * Authorization-aware lookup. Returns the row only when its
     * `user_id` matches `userId` and its `patient_pid` matches
     * `patientPid` — used by the runner to verify that a follow-up
     * envelope targets a conversation the principal actually owns
     * before appending. Returns `null` when no row matches OR when the
     * row exists but is owned by someone else / lives on a different
     * patient (the caller cannot tell those cases apart, by design).
     */
    readonly findOwnedById: (
        conversationId: string,
        userId: string,
        patientPid: number,
    ) => Promise<ConversationRecord | null>;
}

/**
 * Schema:
 *   - `conversations` is append-only. `created_at` is fixed at insert;
 *     `updated_at` is bumped via `touch()`.
 *   - The (user_id, patient_pid, updated_at DESC) index supports the
 *     resume lookup; no unique constraints because we deliberately allow
 *     multiple historical rows per (user, patient).
 *
 * `setup()` runs every boot and is responsible for migrating older
 * deployments that still carry the §3.5 unique indexes — drop them
 * unconditionally and add the new index. Postgres treats the DROPs as
 * no-ops if the indexes are absent.
 */
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        patient_pid INTEGER NOT NULL,
        appointment_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    DROP INDEX IF EXISTS conversations_lookup_idx_with_appt;
    DROP INDEX IF EXISTS conversations_lookup_idx_no_appt;
    CREATE INDEX IF NOT EXISTS conversations_resume_idx
        ON conversations (user_id, patient_pid, updated_at DESC);
`;

const INSERT_SQL = `
    INSERT INTO conversations (id, user_id, patient_pid, appointment_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, user_id, patient_pid, appointment_id, created_at, updated_at
`;

const FIND_RESUMABLE_SQL = `
    SELECT id, updated_at
    FROM conversations
    WHERE user_id = $1
      AND patient_pid = $2
      AND updated_at > now() - make_interval(hours => $3)
    ORDER BY updated_at DESC
    LIMIT 1
`;

const TOUCH_SQL = `
    UPDATE conversations SET updated_at = now() WHERE id = $1
`;

const FIND_OWNED_BY_ID_SQL = `
    SELECT id, user_id, patient_pid, appointment_id, created_at, updated_at
    FROM conversations
    WHERE id = $1 AND user_id = $2 AND patient_pid = $3
    LIMIT 1
`;

interface ConversationRow {
    readonly id: string;
    readonly user_id: string;
    readonly patient_pid: number;
    readonly appointment_id: string | null;
    readonly created_at: Date;
    readonly updated_at: Date;
}

const rowToRecord = (row: ConversationRow): ConversationRecord => ({
    id: row.id,
    userId: row.user_id,
    patientPid: row.patient_pid,
    appointmentId: row.appointment_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

export interface PgConversationStoreOptions {
    readonly connectionString: string;
}

export const createPgConversationStore = (
    options: PgConversationStoreOptions,
): ConversationStore => {
    if (options.connectionString.trim().length === 0) {
        throw new Error('Postgres connection string is required for conversation store');
    }
    const pool = new pg.Pool({ connectionString: options.connectionString });
    const logger = createLogger('conversationStore');

    const setup = async (): Promise<void> => {
        await pool.query(SCHEMA_SQL);
    };

    const create = async (key: ConversationKey): Promise<ConversationRecord> => {
        const result = await pool.query<ConversationRow>(INSERT_SQL, [
            randomUUID(),
            key.userId,
            key.patientPid,
            key.appointmentId,
        ]);
        const row = result.rows[0];
        if (row === undefined) {
            throw new Error('conversation insert returned no row');
        }
        logger.debug(
            { conversationId: row.id, userId: key.userId, patientPid: key.patientPid },
            'created conversation row',
        );
        return rowToRecord(row);
    };

    const findResumable = async (
        userId: string,
        patientPid: number,
        withinHours: number,
    ): Promise<ResumableConversation | null> => {
        if (withinHours <= 0) return null;
        const result = await pool.query<{ id: string; updated_at: Date }>(
            FIND_RESUMABLE_SQL,
            [userId, patientPid, withinHours],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        return { id: row.id, updatedAt: row.updated_at.toISOString() };
    };

    const touch = async (conversationId: string): Promise<void> => {
        await pool.query(TOUCH_SQL, [conversationId]);
    };

    const findOwnedById = async (
        conversationId: string,
        userId: string,
        patientPid: number,
    ): Promise<ConversationRecord | null> => {
        const result = await pool.query<ConversationRow>(
            FIND_OWNED_BY_ID_SQL,
            [conversationId, userId, patientPid],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        return rowToRecord(row);
    };

    return { setup, create, findResumable, touch, findOwnedById };
};

interface InMemoryRow {
    readonly id: string;
    readonly userId: string;
    readonly patientPid: number;
    readonly appointmentId: string | null;
    readonly createdAt: Date;
    updatedAt: Date;
    /**
     * Monotonic insertion sequence. Used as a tie-breaker on
     * `updatedAt` because `Date.now()` only ticks at ms granularity and
     * tests routinely create + touch within the same ms.
     */
    readonly seq: number;
    touchSeq: number;
}

/**
 * In-memory store for tests. Mirrors the production semantics: every
 * `create()` mints a fresh row, `findResumable` walks rows in reverse
 * insertion order and respects the `withinHours` window, `touch()`
 * bumps `updatedAt` only.
 */
export const createInMemoryConversationStore = (): ConversationStore => {
    const rows: InMemoryRow[] = [];
    let nextSeq = 0;
    const setup = (): Promise<void> => Promise.resolve();
    const create = (key: ConversationKey): Promise<ConversationRecord> => {
        const now = new Date();
        const seq = nextSeq++;
        const row: InMemoryRow = {
            id: randomUUID(),
            userId: key.userId,
            patientPid: key.patientPid,
            appointmentId: key.appointmentId,
            createdAt: now,
            updatedAt: now,
            seq,
            touchSeq: seq,
        };
        rows.push(row);
        return Promise.resolve({
            id: row.id,
            userId: row.userId,
            patientPid: row.patientPid,
            appointmentId: row.appointmentId,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        });
    };
    const findResumable = (
        userId: string,
        patientPid: number,
        withinHours: number,
    ): Promise<ResumableConversation | null> => {
        if (withinHours <= 0) return Promise.resolve(null);
        const cutoff = Date.now() - withinHours * 60 * 60 * 1000;
        const candidates = rows
            .filter((r) => r.userId === userId && r.patientPid === patientPid)
            .filter((r) => r.updatedAt.getTime() > cutoff)
            .sort((a, b) => {
                const dt = b.updatedAt.getTime() - a.updatedAt.getTime();
                if (dt !== 0) return dt;
                return b.touchSeq - a.touchSeq;
            });
        const top = candidates[0];
        if (top === undefined) return Promise.resolve(null);
        return Promise.resolve({ id: top.id, updatedAt: top.updatedAt.toISOString() });
    };
    const touch = (conversationId: string): Promise<void> => {
        const row = rows.find((r) => r.id === conversationId);
        if (row !== undefined) {
            row.updatedAt = new Date();
            row.touchSeq = nextSeq++;
        }
        return Promise.resolve();
    };
    const findOwnedById = (
        conversationId: string,
        userId: string,
        patientPid: number,
    ): Promise<ConversationRecord | null> => {
        const row = rows.find(
            (r) => r.id === conversationId && r.userId === userId && r.patientPid === patientPid,
        );
        if (row === undefined) return Promise.resolve(null);
        return Promise.resolve({
            id: row.id,
            userId: row.userId,
            patientPid: row.patientPid,
            appointmentId: row.appointmentId,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        });
    };
    return { setup, create, findResumable, touch, findOwnedById };
};
