-- Up Migration
-- Baseline migration: pre-migrations DDL for `unverified_claims`.
-- The agent's W1 boot path created this table via inline
-- `CREATE TABLE IF NOT EXISTS` in `agent/src/verify/unverifiedClaimsLog.ts`.
-- This migration captures that DDL so future deployments are tracked.
-- Idempotent: re-running against an already-populated database is a
-- no-op (every statement uses IF [NOT] EXISTS).

CREATE TABLE IF NOT EXISTS unverified_claims (
    id BIGSERIAL PRIMARY KEY,
    request_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    claim_category TEXT NOT NULL,
    source_references JSONB NOT NULL,
    rejection_reason TEXT NOT NULL,
    safety_critical BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unverified_claims_request_idx
    ON unverified_claims (request_id);

CREATE INDEX IF NOT EXISTS unverified_claims_created_at_idx
    ON unverified_claims (created_at);

-- Down Migration
DROP TABLE IF EXISTS unverified_claims;
