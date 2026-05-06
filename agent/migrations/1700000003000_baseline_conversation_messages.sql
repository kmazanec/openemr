-- Up Migration
-- Baseline migration: pre-migrations DDL for `conversation_messages`.

CREATE TABLE IF NOT EXISTS conversation_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_messages_thread_idx
    ON conversation_messages (conversation_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS conversation_messages;
