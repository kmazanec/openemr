-- Up Migration
-- Baseline migration: pre-migrations DDL for `conversation_suggestion_chips`.

CREATE TABLE IF NOT EXISTS conversation_suggestion_chips (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    request_id TEXT NOT NULL,
    chip_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_suggestion_chips_lookup_idx
    ON conversation_suggestion_chips (conversation_id, chip_id);

-- Down Migration
DROP TABLE IF EXISTS conversation_suggestion_chips;
