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

/**
 * One row of the §4.7 history sidebar. `firstQuestion` is the verbatim
 * `text` of the first user turn in the conversation (truncated by the
 * UI, not here). `null` when the conversation only has assistant turns
 * — i.e. a default briefing the clinician opened but never followed up
 * on. `messageCount` is the total number of persisted turns
 * (user + assistant), which the UI shows as a small badge so longer
 * threads are easy to spot.
 */
export interface ConversationListItem {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly messageCount: number;
    readonly firstQuestion: string | null;
}

export interface ConversationListOptions {
    readonly limit: number;
    /**
     * Composite cursor: `(updatedAt, id)` lex pair. Returns rows
     * strictly less than this position — i.e. older. Omit on the
     * first page to get the most recent rows. Composite (rather than
     * `updatedAt` alone) so same-ms ties pick up cleanly across
     * pages instead of being silently dropped.
     */
    readonly before?: { readonly updatedAt: string; readonly id: string };
}

export interface ConversationStore {
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
    /**
     * §4.7 history sidebar. Returns conversations for `(userId,
     * patientPid)` ordered by `updated_at DESC`, including a derived
     * `messageCount` and `firstQuestion` snippet per row. Pagination
     * is via the `before` cursor on `updated_at`; the caller passes
     * the previous page's last `updatedAt` to get the next page.
     *
     * `limit` is capped at 100 inside the store regardless of what
     * the route allows, so a buggy or malicious caller cannot drag
     * an unbounded result set into memory.
     */
    readonly listForUserAndPatient: (
        userId: string,
        patientPid: number,
        options: ConversationListOptions,
    ) => Promise<readonly ConversationListItem[]>;
}

/**
 * Schema:
 *   - `conversations` is append-only. `created_at` is fixed at insert;
 *     `updated_at` is bumped via `touch()`.
 *   - The (user_id, patient_pid, updated_at DESC) index supports the
 *     resume lookup; no unique constraints because we deliberately allow
 *     multiple historical rows per (user, patient).
 *
 * Schema lives in `agent/migrations/` — see
 * `1700000002000_baseline_conversations.sql`.
 */

const INSERT_SQL = `
    INSERT INTO conversations (id, user_id, patient_pid, appointment_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, user_id, patient_pid, appointment_id, created_at, updated_at
`;

/**
 * Every read path filters out conversations with zero persisted
 * messages. The runner inserts the `conversations` row before the
 * briefing graph runs (so a graph failure can be diagnosed against
 * a real id), but if the graph then throws — typical cause: snapshot
 * 403, model timeout — no message is ever appended. Surfacing those
 * empty rows to resume strands the user on a "0 turns" thread with
 * no recourse, so we treat "has at least one message" as the
 * visibility predicate. The
 * `conversation_messages_thread_idx (conversation_id, created_at)`
 * index makes the EXISTS lookup a single index probe.
 */
const FIND_RESUMABLE_SQL = `
    SELECT id, updated_at
    FROM conversations c
    WHERE user_id = $1
      AND patient_pid = $2
      AND updated_at > now() - make_interval(hours => $3)
      AND EXISTS (
          SELECT 1 FROM conversation_messages m
          WHERE m.conversation_id = c.id
      )
    ORDER BY updated_at DESC
    LIMIT 1
`;

const TOUCH_SQL = `
    UPDATE conversations SET updated_at = now() WHERE id = $1
`;

const FIND_OWNED_BY_ID_SQL = `
    SELECT id, user_id, patient_pid, appointment_id, created_at, updated_at
    FROM conversations c
    WHERE id = $1 AND user_id = $2 AND patient_pid = $3
      AND EXISTS (
          SELECT 1 FROM conversation_messages m
          WHERE m.conversation_id = c.id
      )
    LIMIT 1
`;

/**
 * §4.7 history list. The two correlated subqueries (message_count,
 * first_question) keep this to a single round-trip — the
 * `conversation_messages_thread_idx` index supports both lookups, so
 * for the typical conversation (a handful of turns) each adds well
 * under a millisecond. Cursor mode (`updated_at < $4`) is opt-in;
 * the LIST_FIRST variant omits the cursor for the first page so the
 * planner picks the resume index directly.
 *
 * Empty rows (no persisted messages) are filtered out for the same
 * reason as `FIND_RESUMABLE_SQL` — they're orphans from a failed
 * briefing graph, never something the clinician is meant to see.
 */
const LIST_FIRST_PAGE_SQL = `
    SELECT
        c.id,
        c.created_at,
        c.updated_at,
        (SELECT count(*)::int FROM conversation_messages m
            WHERE m.conversation_id = c.id) AS message_count,
        (SELECT m.payload ->> 'text' FROM conversation_messages m
            WHERE m.conversation_id = c.id AND m.role = 'user'
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT 1) AS first_question
    FROM conversations c
    WHERE c.user_id = $1 AND c.patient_pid = $2
      AND EXISTS (
          SELECT 1 FROM conversation_messages m
          WHERE m.conversation_id = c.id
      )
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT $3
`;

const LIST_NEXT_PAGE_SQL = `
    SELECT
        c.id,
        c.created_at,
        c.updated_at,
        (SELECT count(*)::int FROM conversation_messages m
            WHERE m.conversation_id = c.id) AS message_count,
        (SELECT m.payload ->> 'text' FROM conversation_messages m
            WHERE m.conversation_id = c.id AND m.role = 'user'
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT 1) AS first_question
    FROM conversations c
    WHERE c.user_id = $1
      AND c.patient_pid = $2
      AND (c.updated_at, c.id) < ($3, $4)
      AND EXISTS (
          SELECT 1 FROM conversation_messages m
          WHERE m.conversation_id = c.id
      )
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT $5
`;

const LIST_HARD_CAP = 100;

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

    const listForUserAndPatient = async (
        userId: string,
        patientPid: number,
        options: ConversationListOptions,
    ): Promise<readonly ConversationListItem[]> => {
        const limit = Math.max(1, Math.min(LIST_HARD_CAP, options.limit));
        interface ListRow {
            readonly id: string;
            readonly created_at: Date;
            readonly updated_at: Date;
            readonly message_count: number;
            readonly first_question: string | null;
        }
        const result = options.before === undefined
            ? await pool.query<ListRow>(LIST_FIRST_PAGE_SQL, [userId, patientPid, limit])
            : await pool.query<ListRow>(LIST_NEXT_PAGE_SQL, [
                  userId,
                  patientPid,
                  new Date(options.before.updatedAt),
                  options.before.id,
                  limit,
              ]);
        return result.rows.map((r) => ({
            id: r.id,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
            messageCount: r.message_count,
            firstQuestion: r.first_question,
        }));
    };

    return { create, findResumable, touch, findOwnedById, listForUserAndPatient };
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
 * Adapter the in-memory store uses to project the §4.7 history list's
 * `messageCount` and `firstQuestion` fields. Production reads both via
 * SQL on the same connection; tests wire a tiny adapter that walks the
 * in-memory messages store. The adapter receives the role and JSON
 * payload exactly as `conversationMessages` persists them, so the
 * "first user question" derivation logic stays in one place
 * (`firstUserText` below) and matches the production SQL.
 */
export interface ConversationMessagesProjection {
    readonly listMessagesForListing: (
        conversationId: string,
    ) => Promise<readonly { readonly role: 'user' | 'assistant'; readonly payload: unknown }[]>;
}

const firstUserText = (
    messages: readonly { readonly role: 'user' | 'assistant'; readonly payload: unknown }[],
): string | null => {
    for (const m of messages) {
        if (m.role !== 'user') continue;
        const payload = m.payload as { text?: unknown };
        if (typeof payload.text === 'string') return payload.text;
        return null;
    }
    return null;
};

/**
 * In-memory store for tests. Mirrors the production semantics: every
 * `create()` mints a fresh row, `findResumable` walks rows in reverse
 * insertion order and respects the `withinHours` window, `touch()`
 * bumps `updatedAt` only. `listForUserAndPatient` reads
 * `messageCount` / `firstQuestion` via the optional projection
 * adapter; tests that exercise the list pass one, tests that don't
 * see empty counts.
 */
export const createInMemoryConversationStore = (
    messages?: ConversationMessagesProjection,
): ConversationStore => {
    const rows: InMemoryRow[] = [];
    let nextSeq = 0;
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
    /**
     * Mirror of the production `EXISTS (... conversation_messages ...)`
     * predicate. When the projection is wired (production-shape tests
     * and the real in-memory pairing in `index.ts`), an empty thread
     * is treated as "not yet visible" so a failed briefing's orphan
     * row never gets returned for resume. Tests that omit the
     * projection retain the previous "all rows visible" semantics —
     * those tests don't exercise the resume → empty-thread path.
     */
    const hasMessages = async (conversationId: string): Promise<boolean> => {
        if (messages === undefined) return true;
        const persisted = await messages.listMessagesForListing(conversationId);
        return persisted.length > 0;
    };
    const findResumable = async (
        userId: string,
        patientPid: number,
        withinHours: number,
    ): Promise<ResumableConversation | null> => {
        if (withinHours <= 0) return null;
        const cutoff = Date.now() - withinHours * 60 * 60 * 1000;
        const candidates = rows
            .filter((r) => r.userId === userId && r.patientPid === patientPid)
            .filter((r) => r.updatedAt.getTime() > cutoff)
            .sort((a, b) => {
                const dt = b.updatedAt.getTime() - a.updatedAt.getTime();
                if (dt !== 0) return dt;
                return b.touchSeq - a.touchSeq;
            });
        for (const row of candidates) {
            if (await hasMessages(row.id)) {
                return { id: row.id, updatedAt: row.updatedAt.toISOString() };
            }
        }
        return null;
    };
    const touch = (conversationId: string): Promise<void> => {
        const row = rows.find((r) => r.id === conversationId);
        if (row !== undefined) {
            row.updatedAt = new Date();
            row.touchSeq = nextSeq++;
        }
        return Promise.resolve();
    };
    const findOwnedById = async (
        conversationId: string,
        userId: string,
        patientPid: number,
    ): Promise<ConversationRecord | null> => {
        const row = rows.find(
            (r) => r.id === conversationId && r.userId === userId && r.patientPid === patientPid,
        );
        if (row === undefined) return null;
        if (!(await hasMessages(row.id))) return null;
        return {
            id: row.id,
            userId: row.userId,
            patientPid: row.patientPid,
            appointmentId: row.appointmentId,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    };
    const listForUserAndPatient = async (
        userId: string,
        patientPid: number,
        options: ConversationListOptions,
    ): Promise<readonly ConversationListItem[]> => {
        const limit = Math.max(1, Math.min(LIST_HARD_CAP, options.limit));
        const cursorMs = options.before === undefined
            ? Number.POSITIVE_INFINITY
            : new Date(options.before.updatedAt).getTime();
        const cursorId = options.before?.id ?? '';
        const candidates = rows
            .filter((r) => r.userId === userId && r.patientPid === patientPid)
            .filter((r) => {
                if (options.before === undefined) return true;
                const ms = r.updatedAt.getTime();
                if (ms < cursorMs) return true;
                if (ms > cursorMs) return false;
                // ms tie → strict id less-than to avoid re-emitting the
                // cursor row on the next page.
                return r.id < cursorId;
            })
            .sort((a, b) => {
                const dt = b.updatedAt.getTime() - a.updatedAt.getTime();
                if (dt !== 0) return dt;
                // Same ms: tie-break by id DESC, matching the
                // production SQL `ORDER BY updated_at DESC, id DESC`.
                if (a.id < b.id) return 1;
                if (a.id > b.id) return -1;
                return 0;
            });
        const items: ConversationListItem[] = [];
        for (const row of candidates) {
            if (items.length >= limit) break;
            const persisted = messages !== undefined
                ? await messages.listMessagesForListing(row.id)
                : [];
            // Mirror of the production EXISTS filter — orphans from
            // a failed briefing graph never appear in the sidebar.
            if (messages !== undefined && persisted.length === 0) continue;
            items.push({
                id: row.id,
                createdAt: row.createdAt.toISOString(),
                updatedAt: row.updatedAt.toISOString(),
                messageCount: persisted.length,
                firstQuestion: firstUserText(persisted),
            });
        }
        return items;
    };
    return {
        create,
        findResumable,
        touch,
        findOwnedById,
        listForUserAndPatient,
    };
};
