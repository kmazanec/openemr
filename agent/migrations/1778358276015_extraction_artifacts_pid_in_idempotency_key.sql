-- Up Migration
-- Add `pid` to the extraction-artifact idempotency key.
--
-- The original baseline keyed on `(document_hash, extractor_version)` only.
-- Same bytes uploaded under two different patients silently aliased to the
-- first artifact's pid, so a re-upload after a patient switch returned the
-- wrong patient's row from the persist node's `findArtifactByDocumentHash`
-- short-circuit. Including `pid` keeps the row-per-(patient, bytes,
-- extractor) shape the persist node actually wants.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'extraction_artifacts_doc_hash_extractor_pid_key'
    ) THEN
        ALTER TABLE extraction_artifacts
            ADD CONSTRAINT extraction_artifacts_doc_hash_extractor_pid_key
            UNIQUE (document_hash, extractor_version, pid);
    END IF;
END
$$;

ALTER TABLE extraction_artifacts
    DROP CONSTRAINT IF EXISTS extraction_artifacts_document_hash_extractor_version_key;

-- Down Migration
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'extraction_artifacts_document_hash_extractor_version_key'
    ) THEN
        ALTER TABLE extraction_artifacts
            ADD CONSTRAINT extraction_artifacts_document_hash_extractor_version_key
            UNIQUE (document_hash, extractor_version);
    END IF;
END
$$;

ALTER TABLE extraction_artifacts
    DROP CONSTRAINT IF EXISTS extraction_artifacts_doc_hash_extractor_pid_key;
