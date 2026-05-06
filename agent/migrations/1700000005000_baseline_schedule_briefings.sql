-- Up Migration
-- Baseline migration: pre-migrations DDL for `schedule_briefings`.

CREATE TABLE IF NOT EXISTS schedule_briefings (
    id BIGSERIAL PRIMARY KEY,
    practitioner_uuid TEXT NOT NULL,
    appointment_id TEXT NOT NULL,
    summary JSONB NOT NULL,
    flags JSONB NOT NULL,
    request_id TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS schedule_briefings_unique
    ON schedule_briefings (
        practitioner_uuid,
        appointment_id,
        ((generated_at AT TIME ZONE 'UTC')::date)
    );

CREATE INDEX IF NOT EXISTS schedule_briefings_practitioner_idx
    ON schedule_briefings (practitioner_uuid, generated_at);

-- Down Migration
DROP TABLE IF EXISTS schedule_briefings;
