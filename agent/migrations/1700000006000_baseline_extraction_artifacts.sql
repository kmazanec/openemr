-- Up Migration
-- Baseline migration: pre-migrations DDL for `extraction_artifacts` (§B.1).

CREATE TABLE IF NOT EXISTS extraction_artifacts (
    artifact_id UUID PRIMARY KEY,
    document_uuid VARCHAR(36) NOT NULL,
    pid INTEGER NOT NULL,
    doc_type VARCHAR(32) NOT NULL,
    extractor_version VARCHAR(32) NOT NULL,
    schema_json JSONB NOT NULL,
    deltas_json JSONB,
    confidence_signal JSONB,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_confirmation',
    document_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    confirmed_by_user UUID,
    UNIQUE (document_hash, extractor_version)
);

CREATE INDEX IF NOT EXISTS extraction_artifacts_pid_doctype_status_idx
    ON extraction_artifacts (pid, doc_type, status);

CREATE INDEX IF NOT EXISTS extraction_artifacts_pid_created_idx
    ON extraction_artifacts (pid, created_at);

-- Down Migration
DROP TABLE IF EXISTS extraction_artifacts;
