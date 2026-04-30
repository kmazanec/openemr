import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { createLogger } from '../observability/logger.js';

/**
 * §3.5: conversation persistence. USERS.md treats a "conversation" as the
 * thread of briefing turns a clinician has with the agent for a specific
 * patient (and, when relevant, appointment). On first chart open we mint a
 * canonical conversation id; subsequent opens by the same actor for the
 * same patient resume the same conversation, which lets the LangGraph
 * checkpointer (keyed by `thread_id`) replay prior reasoning.
 *
 * The lookup tuple is `(user_id, patient_pid, appointment_id?)`. The plan
 * pins `appointment_id` as nullable because UC1 may run outside an
 * appointment context. The agent does the resolution server-side, so the
 * browser-supplied `conversationId` in the request envelope is now only a
 * trace token — the canonical id used for checkpointing is the one this
 * store hands back.
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
}

export interface FindOrCreateResult {
    readonly conversation: ConversationRecord;
    /** True only on the first call for this key — useful for telemetry and for asserting resume behavior in tests. */
    readonly created: boolean;
}

export interface ConversationStore {
    readonly setup: () => Promise<void>;
    readonly findOrCreate: (key: ConversationKey) => Promise<FindOrCreateResult>;
}

/**
 * Schema lives in agent Postgres alongside the LangGraph checkpoints and
 * the unverified-claims log. `appointment_id` is a plain TEXT column with
 * no foreign key — appointments live in OpenEMR's MySQL, not here. The
 * unique index makes `findOrCreate` race-safe under the
 * INSERT … ON CONFLICT path below.
 */
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        patient_pid INTEGER NOT NULL,
        appointment_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_lookup_idx_with_appt
        ON conversations (user_id, patient_pid, appointment_id)
        WHERE appointment_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_lookup_idx_no_appt
        ON conversations (user_id, patient_pid)
        WHERE appointment_id IS NULL;
`;

const SELECT_SQL_WITH_APPT = `
    SELECT id, user_id, patient_pid, appointment_id, created_at
    FROM conversations
    WHERE user_id = $1 AND patient_pid = $2 AND appointment_id = $3
    LIMIT 1
`;

const SELECT_SQL_NULL_APPT = `
    SELECT id, user_id, patient_pid, appointment_id, created_at
    FROM conversations
    WHERE user_id = $1 AND patient_pid = $2 AND appointment_id IS NULL
    LIMIT 1
`;

const INSERT_SQL = `
    INSERT INTO conversations (id, user_id, patient_pid, appointment_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, user_id, patient_pid, appointment_id, created_at
`;

interface ConversationRow {
    readonly id: string;
    readonly user_id: string;
    readonly patient_pid: number;
    readonly appointment_id: string | null;
    readonly created_at: Date;
}

const rowToRecord = (row: ConversationRow): ConversationRecord => ({
    id: row.id,
    userId: row.user_id,
    patientPid: row.patient_pid,
    appointmentId: row.appointment_id,
    createdAt: row.created_at.toISOString(),
});

export interface PgConversationStoreOptions {
    readonly connectionString: string;
}

/**
 * Postgres-backed store. `findOrCreate` first SELECTs and then INSERTs on
 * miss; if a concurrent request raced us to insert (the unique indexes
 * above guarantee at most one row per key), we fall back to a second
 * SELECT and report `created: false`. This matches the resume semantics
 * the rest of the runner relies on.
 */
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

    const select = async (key: ConversationKey): Promise<ConversationRecord | null> => {
        const sql = key.appointmentId === null ? SELECT_SQL_NULL_APPT : SELECT_SQL_WITH_APPT;
        const params: readonly unknown[] = key.appointmentId === null
            ? [key.userId, key.patientPid]
            : [key.userId, key.patientPid, key.appointmentId];
        const result = await pool.query<ConversationRow>(sql, params as unknown[]);
        if (result.rows.length === 0) return null;
        return rowToRecord(result.rows[0]!);
    };

    const findOrCreate = async (key: ConversationKey): Promise<FindOrCreateResult> => {
        const existing = await select(key);
        if (existing !== null) {
            return { conversation: existing, created: false };
        }
        try {
            const inserted = await pool.query<ConversationRow>(INSERT_SQL, [
                randomUUID(),
                key.userId,
                key.patientPid,
                key.appointmentId,
            ]);
            return { conversation: rowToRecord(inserted.rows[0]!), created: true };
        } catch (err: unknown) {
            // Concurrent insert won the race. Re-select; if the row is
            // still missing, the failure is something else and must
            // surface to the caller.
            const racedRow = await select(key);
            if (racedRow !== null) {
                logger.debug({ userId: key.userId, patientPid: key.patientPid }, 'conversation insert raced; resuming existing row');
                return { conversation: racedRow, created: false };
            }
            throw err;
        }
    };

    return { setup, findOrCreate };
};

const keyToString = (key: ConversationKey): string =>
    `${key.userId}|${String(key.patientPid)}|${key.appointmentId ?? ''}`;

/**
 * In-memory store for tests. Mirrors the same find-or-create semantics
 * the production store provides; production always wires the Pg variant.
 */
export const createInMemoryConversationStore = (): ConversationStore => {
    const records = new Map<string, ConversationRecord>();
    const setup = (): Promise<void> => Promise.resolve();
    const findOrCreate = (key: ConversationKey): Promise<FindOrCreateResult> => {
        const cacheKey = keyToString(key);
        const existing = records.get(cacheKey);
        if (existing !== undefined) {
            return Promise.resolve({ conversation: existing, created: false });
        }
        const conversation: ConversationRecord = {
            id: randomUUID(),
            userId: key.userId,
            patientPid: key.patientPid,
            appointmentId: key.appointmentId,
            createdAt: new Date().toISOString(),
        };
        records.set(cacheKey, conversation);
        return Promise.resolve({ conversation, created: true });
    };
    return { setup, findOrCreate };
};
