-- Up Migration
-- §F.3 Per-fact disposition tracking. One row per (artifact, field
-- path); FK + ON DELETE CASCADE ties lifecycle to the parent artifact.
-- Status is application-managed (parsed via `parseDispositionStatus`)
-- so adding a future status doesn't require a schema change.

CREATE TABLE IF NOT EXISTS extracted_fact_dispositions (
    artifact_id UUID NOT NULL REFERENCES extraction_artifacts(artifact_id) ON DELETE CASCADE,
    field_path VARCHAR(256) NOT NULL,
    status VARCHAR(16) NOT NULL,
    accepted_at TIMESTAMPTZ,
    accepted_by_user UUID,
    PRIMARY KEY (artifact_id, field_path)
);

CREATE INDEX IF NOT EXISTS extracted_fact_dispositions_artifact_idx
    ON extracted_fact_dispositions (artifact_id);

-- Down Migration
DROP TABLE IF EXISTS extracted_fact_dispositions;
