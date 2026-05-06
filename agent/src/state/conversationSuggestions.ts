import { randomUUID } from 'node:crypto';

import pg from 'pg';

/**
 * Per-conversation suggested-follow-up chip IDs.
 *
 * The §4.1 follow-ups generator hands the panel a small set of typed
 * suggestion chips. Each chip carries a SHA1-derived `id` that the panel
 * sends back as a hidden field on the next user turn (recomputed
 * server-side from `(conversationId, params)` — see Path B note in
 * `server/index.ts`). This store records the chip IDs the panel was
 * actually shown so a follow-up turn can be rejected if its chip isn't
 * one we offered.
 *
 * Defense-in-depth: the typed `followUp` params already pass a Zod
 * validation gate at the route boundary, but a clinician with a stale
 * tab or a malicious caller can construct any well-formed params they
 * like. Pinning the chip ID against the persisted set means a user-driven
 * turn can only invoke the analyses we put in front of them.
 *
 * Layering:
 *   - Append-only — every default_briefing turn writes a fresh row keyed
 *     by `(conversation_id, request_id)`. We never overwrite, so an audit
 *     reader can trace which chip set powered which user turn.
 *   - Lookups index `(conversation_id, chip_id)` directly because that's
 *     the access pattern of every follow-up turn; the per-turn `request_id`
 *     is informational, not load-bearing.
 *
 * Failure mode: a write failure is logged and ignored — the follow-up
 * lookup will then return false on the next turn, which is the correct
 * fail-closed behavior. The user-visible default-briefing turn is not
 * blocked on this side-channel.
 */

export interface SuggestionSetWrite {
    readonly conversationId: string;
    readonly requestId: string;
    readonly chipIds: readonly string[];
}

export interface ConversationSuggestionStore {
    /**
     * Record the chip IDs offered on a default_briefing turn. No-op when
     * `chipIds` is empty (a turn that produced no suggestions has nothing
     * to validate against later).
     */
    readonly record: (input: SuggestionSetWrite) => Promise<void>;
    /**
     * True iff `chipId` was previously recorded for `conversationId` on
     * any turn. Cross-conversation replay (chip from conversation A used
     * on conversation B) returns false.
     */
    readonly hasChip: (conversationId: string, chipId: string) => Promise<boolean>;
}

// Schema lives in `agent/migrations/1700000004000_baseline_conversation_suggestion_chips.sql`.

const INSERT_SQL = `
    INSERT INTO conversation_suggestion_chips
        (id, conversation_id, request_id, chip_id)
    VALUES ($1, $2, $3, $4)
`;

const HAS_CHIP_SQL = `
    SELECT 1
    FROM conversation_suggestion_chips
    WHERE conversation_id = $1 AND chip_id = $2
    LIMIT 1
`;

export interface PgConversationSuggestionStoreOptions {
    readonly connectionString: string;
}

export const createPgConversationSuggestionStore = (
    options: PgConversationSuggestionStoreOptions,
): ConversationSuggestionStore => {
    if (options.connectionString.trim().length === 0) {
        throw new Error('Postgres connection string is required for suggestion store');
    }
    const pool = new pg.Pool({ connectionString: options.connectionString });
    const record = async (input: SuggestionSetWrite): Promise<void> => {
        if (input.chipIds.length === 0) return;
        // One INSERT per chip; the suggestion set is always small (≤5 by
        // the generator's TOTAL_CAP) so a batched write is unnecessary
        // overhead.
        for (const chipId of input.chipIds) {
            await pool.query(INSERT_SQL, [
                randomUUID(),
                input.conversationId,
                input.requestId,
                chipId,
            ]);
        }
    };
    const hasChip = async (conversationId: string, chipId: string): Promise<boolean> => {
        const result = await pool.query(HAS_CHIP_SQL, [conversationId, chipId]);
        return result.rowCount !== null && result.rowCount > 0;
    };
    return { record, hasChip };
};

export const createInMemoryConversationSuggestionStore = (): ConversationSuggestionStore => {
    const rows: { conversationId: string; chipId: string }[] = [];
    const record = (input: SuggestionSetWrite): Promise<void> => {
        for (const chipId of input.chipIds) {
            rows.push({ conversationId: input.conversationId, chipId });
        }
        return Promise.resolve();
    };
    const hasChip = (conversationId: string, chipId: string): Promise<boolean> =>
        Promise.resolve(rows.some((r) => r.conversationId === conversationId && r.chipId === chipId));
    return { record, hasChip };
};
