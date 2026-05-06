-- Up Migration
-- Baseline migration: pre-migrations DDL for `conversations`.
-- Captures the post-§3.5 schema (with `updated_at`, the resume index,
-- and the legacy lookup-index drops) as it stood at master before the
-- introduction of node-pg-migrate. The legacy index DROPs are
-- preserved because some long-running deployments may still carry
-- those indexes; idempotent on fresh databases (no-op DROP IF EXISTS).

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

-- Down Migration
DROP INDEX IF EXISTS conversations_resume_idx;
DROP TABLE IF EXISTS conversations;
