import { randomUUID } from 'node:crypto';

import pg from 'pg';

import type { AssistantMessage } from '../graph/types.js';

/**
 * §4.6: read-side store for the conversation thread the panel renders on
 * resume. Every persisted turn — clinician question and verified
 * assistant message — is mirrored here so the resume endpoint can replay
 * the conversation without reaching into the LangGraph checkpointer's
 * internal state. A future "conversation history" UI reads from the same
 * table.
 *
 * Layering: this is a dual-write alongside the LangGraph checkpointer.
 * The checkpointer remains the source of truth for the graph state
 * needed to continue reasoning; this table is the source of truth for
 * the rendered UI thread.
 */

export type ConversationMessage =
    | { readonly role: 'user'; readonly text: string; readonly createdAt: string }
    | { readonly role: 'assistant'; readonly message: AssistantMessage; readonly createdAt: string };

export interface AppendUserMessage {
    readonly conversationId: string;
    readonly role: 'user';
    readonly text: string;
}

export interface AppendAssistantMessage {
    readonly conversationId: string;
    readonly role: 'assistant';
    readonly message: AssistantMessage;
}

export type AppendInput = AppendUserMessage | AppendAssistantMessage;

export interface ConversationMessagesStore {
    readonly setup: () => Promise<void>;
    readonly append: (input: AppendInput) => Promise<void>;
    readonly listForConversation: (conversationId: string) => Promise<readonly ConversationMessage[]>;
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS conversation_messages (
        id UUID PRIMARY KEY,
        conversation_id UUID NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversation_messages_thread_idx
        ON conversation_messages (conversation_id, created_at);
`;

const INSERT_SQL = `
    INSERT INTO conversation_messages (id, conversation_id, role, payload)
    VALUES ($1, $2, $3, $4)
`;

const LIST_SQL = `
    SELECT role, payload, created_at
    FROM conversation_messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC, id ASC
`;

interface MessageRow {
    readonly role: 'user' | 'assistant';
    readonly payload: unknown;
    readonly created_at: Date;
}

const rowToMessage = (row: MessageRow): ConversationMessage => {
    const createdAt = row.created_at.toISOString();
    if (row.role === 'user') {
        const payload = row.payload as { text?: unknown };
        const text = typeof payload.text === 'string' ? payload.text : '';
        return { role: 'user', text, createdAt };
    }
    return { role: 'assistant', message: row.payload as AssistantMessage, createdAt };
};

const payloadFor = (input: AppendInput): unknown => {
    if (input.role === 'user') return { text: input.text };
    return input.message;
};

export interface PgConversationMessagesStoreOptions {
    readonly connectionString: string;
}

export const createPgConversationMessagesStore = (
    options: PgConversationMessagesStoreOptions,
): ConversationMessagesStore => {
    if (options.connectionString.trim().length === 0) {
        throw new Error('Postgres connection string is required for conversation messages store');
    }
    const pool = new pg.Pool({ connectionString: options.connectionString });
    const setup = async (): Promise<void> => {
        await pool.query(SCHEMA_SQL);
    };
    const append = async (input: AppendInput): Promise<void> => {
        await pool.query(INSERT_SQL, [
            randomUUID(),
            input.conversationId,
            input.role,
            JSON.stringify(payloadFor(input)),
        ]);
    };
    const listForConversation = async (
        conversationId: string,
    ): Promise<readonly ConversationMessage[]> => {
        const result = await pool.query<MessageRow>(LIST_SQL, [conversationId]);
        return result.rows.map(rowToMessage);
    };
    return { setup, append, listForConversation };
};

interface InMemoryMessageRow {
    readonly conversationId: string;
    readonly role: 'user' | 'assistant';
    readonly payload: unknown;
    readonly createdAt: Date;
    readonly seq: number;
}

export const createInMemoryConversationMessagesStore = (): ConversationMessagesStore => {
    const rows: InMemoryMessageRow[] = [];
    let nextSeq = 0;
    const setup = (): Promise<void> => Promise.resolve();
    const append = (input: AppendInput): Promise<void> => {
        rows.push({
            conversationId: input.conversationId,
            role: input.role,
            payload: payloadFor(input),
            createdAt: new Date(),
            seq: nextSeq++,
        });
        return Promise.resolve();
    };
    const listForConversation = (
        conversationId: string,
    ): Promise<readonly ConversationMessage[]> => {
        const filtered = rows
            .filter((r) => r.conversationId === conversationId)
            .sort((a, b) => {
                const dt = a.createdAt.getTime() - b.createdAt.getTime();
                if (dt !== 0) return dt;
                return a.seq - b.seq;
            });
        const messages: ConversationMessage[] = filtered.map((r) => {
            const createdAt = r.createdAt.toISOString();
            if (r.role === 'user') {
                const payload = r.payload as { text?: unknown };
                const text = typeof payload.text === 'string' ? payload.text : '';
                return { role: 'user', text, createdAt };
            }
            return { role: 'assistant', message: r.payload as AssistantMessage, createdAt };
        });
        return Promise.resolve(messages);
    };
    return { setup, append, listForConversation };
};
