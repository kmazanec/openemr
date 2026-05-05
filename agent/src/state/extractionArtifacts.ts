import { createHash } from 'node:crypto';

import pg from 'pg';

import { createLogger } from '../observability/logger.js';

/**
 * §B.1 Tier-2 extraction artifact store. Owns the
 * `extraction_artifacts` table — what the document ingestion pipeline
 * writes after `vision → schemaValidate → patientMatch` succeed, and
 * what the conversational graph's `documentEvidenceRetriever` (C.1)
 * reads to surface cited extracted facts. Tier 2 *never auto-writes
 * to the chart*; Tier-3 promotion is gated by explicit clinician
 * accept on inline UI controls (Phase F).
 *
 * The DDL mirrors `W2_ARCHITECTURE.md` §"Tier 2 — extraction artifact"
 * exactly: a UUID PK, FK column to OpenEMR's `DocumentReference`, the
 * full extracted JSON, deltas vs chart, per-field confidence, status
 * lifecycle (`pending_confirmation` → `confirmed`/`rejected`/
 * `superseded`/`failed`), the idempotency key (`document_hash`,
 * `extractor_version`).
 *
 * The advisory-lock helper is the race-safety floor for the pipeline
 * entry: when two callers (panel upload, document-event listener,
 * CLI replay) trigger extraction for the same `document_uuid` at the
 * same time, exactly one wins the lock and runs vision; the other
 * blocks until the winner releases, then short-circuits via the
 * UNIQUE-(document_hash, extractor_version) idempotency check and
 * returns the cached artifact id.
 */

export type DocumentType = 'lab_pdf' | 'intake_form';

export type ArtifactStatus =
    | 'pending_confirmation'
    | 'confirmed'
    | 'rejected'
    | 'superseded'
    | 'failed';

const KNOWN_STATUSES: ReadonlySet<ArtifactStatus> = new Set<ArtifactStatus>([
    'pending_confirmation',
    'confirmed',
    'rejected',
    'superseded',
    'failed',
]);

export interface NewExtractionArtifact {
    readonly artifactId: string;
    readonly documentUuid: string;
    readonly pid: number;
    readonly docType: DocumentType;
    readonly extractorVersion: string;
    readonly schemaJson: unknown;
    /** SQL NULL when no deltas computed yet (e.g., the `failed` path before `emitDeltas`). */
    readonly deltasJson: unknown;
    /** SQL NULL when no patientMatch / pipeline-confidence info is attached. */
    readonly confidenceSignal: unknown;
    readonly status: ArtifactStatus;
    readonly documentHash: string;
}

export interface ExtractionArtifact {
    readonly artifactId: string;
    readonly documentUuid: string;
    readonly pid: number;
    readonly docType: DocumentType;
    readonly extractorVersion: string;
    readonly schemaJson: unknown;
    /** SQL NULL when no deltas computed yet (e.g., the `failed` path before `emitDeltas`). */
    readonly deltasJson: unknown;
    /** SQL NULL when no patientMatch / pipeline-confidence info is attached. */
    readonly confidenceSignal: unknown;
    readonly status: ArtifactStatus;
    readonly documentHash: string;
    readonly createdAt: string;
    readonly confirmedAt: string | null;
    readonly confirmedByUser: string | null;
}

export interface DocumentLockHandle {
    readonly release: () => Promise<void>;
}

export interface ExtractionArtifactStore {
    readonly setup: () => Promise<void>;
    readonly claimDocumentLock: (
        documentUuid: string,
        options?: { readonly timeoutMs?: number },
    ) => Promise<DocumentLockHandle>;
    readonly findArtifactByDocumentHash: (
        documentHash: string,
        extractorVersion: string,
    ) => Promise<ExtractionArtifact | null>;
    readonly insertArtifact: (
        artifact: NewExtractionArtifact,
    ) => Promise<ExtractionArtifact>;
    readonly updateArtifactStatus: (
        artifactId: string,
        status: ArtifactStatus,
        metadata?: {
            readonly confidenceSignal?: unknown;
            readonly deltasJson?: unknown;
            readonly confirmedAt?: string;
            readonly confirmedByUser?: string;
        },
    ) => Promise<ExtractionArtifact | null>;
}

const SCHEMA_SQL = `
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
`;

const FIND_BY_HASH_SQL = `
    SELECT
        artifact_id,
        document_uuid,
        pid,
        doc_type,
        extractor_version,
        schema_json,
        deltas_json,
        confidence_signal,
        status,
        document_hash,
        created_at,
        confirmed_at,
        confirmed_by_user
    FROM extraction_artifacts
    WHERE document_hash = $1 AND extractor_version = $2
    LIMIT 1
`;

const INSERT_SQL = `
    INSERT INTO extraction_artifacts (
        artifact_id, document_uuid, pid, doc_type, extractor_version,
        schema_json, deltas_json, confidence_signal, status, document_hash
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING
        artifact_id,
        document_uuid,
        pid,
        doc_type,
        extractor_version,
        schema_json,
        deltas_json,
        confidence_signal,
        status,
        document_hash,
        created_at,
        confirmed_at,
        confirmed_by_user
`;

const UPDATE_STATUS_SQL = `
    UPDATE extraction_artifacts
    SET status = $2,
        confidence_signal = COALESCE($3, confidence_signal),
        deltas_json = COALESCE($4, deltas_json),
        confirmed_at = COALESCE($5::timestamptz, confirmed_at),
        confirmed_by_user = COALESCE($6::uuid, confirmed_by_user)
    WHERE artifact_id = $1
    RETURNING
        artifact_id,
        document_uuid,
        pid,
        doc_type,
        extractor_version,
        schema_json,
        deltas_json,
        confidence_signal,
        status,
        document_hash,
        created_at,
        confirmed_at,
        confirmed_by_user
`;

const TRY_ADVISORY_LOCK_SQL = 'SELECT pg_try_advisory_lock($1) AS locked';
const ADVISORY_UNLOCK_SQL = 'SELECT pg_advisory_unlock($1) AS released';

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_INTERVAL_MS = 100;

/**
 * Hash a UUID into the signed-int64 range Postgres expects for
 * `pg_advisory_lock(bigint)`. SHA-256 → take the first 8 bytes →
 * read as a signed BigInt. Two distinct UUIDs collide with
 * probability ≈ 2⁻⁶⁴ which is acceptable for this lock — collisions
 * just serialize unrelated documents briefly; they don't violate
 * correctness because the UNIQUE-(document_hash, extractor_version)
 * row constraint is the actual idempotency floor.
 */
const advisoryLockKey = (documentUuid: string): bigint => {
    const digest = createHash('sha256').update(documentUuid).digest();
    return digest.readBigInt64BE(0);
};

export class DocumentLockTimeoutError extends Error {
    public readonly documentUuid: string;
    public readonly timeoutMs: number;

    public constructor(documentUuid: string, timeoutMs: number) {
        super(
            `timed out after ${timeoutMs}ms waiting for advisory lock on document ${documentUuid}`,
        );
        this.name = 'DocumentLockTimeoutError';
        this.documentUuid = documentUuid;
        this.timeoutMs = timeoutMs;
    }
}

interface ArtifactRow {
    readonly artifact_id: string;
    readonly document_uuid: string;
    readonly pid: number;
    readonly doc_type: string;
    readonly extractor_version: string;
    readonly schema_json: unknown;
    readonly deltas_json: unknown;
    readonly confidence_signal: unknown;
    readonly status: string;
    readonly document_hash: string;
    readonly created_at: Date | string;
    readonly confirmed_at: Date | string | null;
    readonly confirmed_by_user: string | null;
}

const parseDocType = (raw: string): DocumentType => {
    if (raw === 'lab_pdf' || raw === 'intake_form') return raw;
    throw new Error(`unexpected doc_type from extraction_artifacts row: ${raw}`);
};

const parseStatus = (raw: string): ArtifactStatus => {
    if (KNOWN_STATUSES.has(raw as ArtifactStatus)) return raw as ArtifactStatus;
    throw new Error(`unexpected status from extraction_artifacts row: ${raw}`);
};

const toIsoString = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : value;

const rowToArtifact = (row: ArtifactRow): ExtractionArtifact => ({
    artifactId: row.artifact_id,
    documentUuid: row.document_uuid,
    pid: row.pid,
    docType: parseDocType(row.doc_type),
    extractorVersion: row.extractor_version,
    schemaJson: row.schema_json,
    deltasJson: row.deltas_json ?? null,
    confidenceSignal: row.confidence_signal ?? null,
    status: parseStatus(row.status),
    documentHash: row.document_hash,
    createdAt: toIsoString(row.created_at),
    confirmedAt: row.confirmed_at === null ? null : toIsoString(row.confirmed_at),
    confirmedByUser: row.confirmed_by_user,
});

/**
 * Minimum surface this module needs from a `pg.Pool`. Carved out for
 * the same reason as `scheduleBriefings.ts`'s `PoolLike` — Vitest
 * tests pass a fake here so SQL is asserted against fixed plans
 * without booting Postgres.
 */
export interface PoolLike {
    readonly query: (
        sql: string,
        params?: readonly unknown[],
    ) => Promise<{
        readonly rowCount: number | null;
        readonly rows: readonly Record<string, unknown>[];
    }>;
    readonly connect: () => Promise<{
        readonly query: (
            sql: string,
            params?: readonly unknown[],
        ) => Promise<{
            readonly rowCount: number | null;
            readonly rows: readonly Record<string, unknown>[];
        }>;
        readonly release: () => void;
    }>;
}

export interface PgExtractionArtifactStoreOptions {
    readonly connectionString: string;
}

export const createPgExtractionArtifactStore = (
    options: PgExtractionArtifactStoreOptions,
): ExtractionArtifactStore => {
    if (options.connectionString.trim().length === 0) {
        throw new Error('Postgres connection string is required for extraction-artifact store');
    }
    const pool = new pg.Pool({ connectionString: options.connectionString });
    return createExtractionArtifactStoreFromPool(pool);
};

/**
 * Pool-injectable factory. Production code uses
 * {@link createPgExtractionArtifactStore}; tests pass a {@link PoolLike}
 * fake that returns scripted query results.
 */
export const createExtractionArtifactStoreFromPool = (
    pool: PoolLike,
    deps: { readonly sleepMs?: (ms: number) => Promise<void> } = {},
): ExtractionArtifactStore => {
    const logger = createLogger('extractionArtifactStore');
    const sleep = deps.sleepMs
        ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

    const setup = async (): Promise<void> => {
        await pool.query(SCHEMA_SQL);
    };

    const claimDocumentLock = async (
        documentUuid: string,
        options: { readonly timeoutMs?: number } = {},
    ): Promise<DocumentLockHandle> => {
        const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
        const key = advisoryLockKey(documentUuid);
        // Advisory locks are session-scoped: the same connection
        // that took the lock must release it. Pin a dedicated client
        // for the lifetime of the lock and release it inside
        // `release()` so the pool isn't tied up indefinitely.
        const client = await pool.connect();
        const deadline = Date.now() + timeoutMs;
        try {
            for (;;) {
                const result = await client.query(TRY_ADVISORY_LOCK_SQL, [key.toString()]);
                if (result.rows[0]?.['locked'] === true) {
                    break;
                }
                if (Date.now() >= deadline) {
                    throw new DocumentLockTimeoutError(documentUuid, timeoutMs);
                }
                await sleep(LOCK_POLL_INTERVAL_MS);
            }
        } catch (err: unknown) {
            client.release();
            throw err;
        }

        let released = false;
        const release = async (): Promise<void> => {
            if (released) return;
            released = true;
            try {
                await client.query(ADVISORY_UNLOCK_SQL, [key.toString()]);
            } catch (err: unknown) {
                logger.warn(
                    { err, documentUuid },
                    'failed to release advisory lock cleanly; backstop is connection close',
                );
            } finally {
                client.release();
            }
        };
        return { release };
    };

    const findArtifactByDocumentHash = async (
        documentHash: string,
        extractorVersion: string,
    ): Promise<ExtractionArtifact | null> => {
        const result = await pool.query(FIND_BY_HASH_SQL, [documentHash, extractorVersion]);
        const row = result.rows[0];
        if (row === undefined) return null;
        return rowToArtifact(row as unknown as ArtifactRow);
    };

    const insertArtifact = async (
        artifact: NewExtractionArtifact,
    ): Promise<ExtractionArtifact> => {
        const result = await pool.query(INSERT_SQL, [
            artifact.artifactId,
            artifact.documentUuid,
            artifact.pid,
            artifact.docType,
            artifact.extractorVersion,
            JSON.stringify(artifact.schemaJson),
            artifact.deltasJson === null ? null : JSON.stringify(artifact.deltasJson),
            artifact.confidenceSignal === null ? null : JSON.stringify(artifact.confidenceSignal),
            artifact.status,
            artifact.documentHash,
        ]);
        const row = result.rows[0];
        if (row === undefined) {
            throw new Error('extraction_artifacts insert returned no row');
        }
        return rowToArtifact(row as unknown as ArtifactRow);
    };

    const updateArtifactStatus = async (
        artifactId: string,
        status: ArtifactStatus,
        metadata: {
            readonly confidenceSignal?: unknown;
            readonly deltasJson?: unknown;
            readonly confirmedAt?: string;
            readonly confirmedByUser?: string;
        } = {},
    ): Promise<ExtractionArtifact | null> => {
        const result = await pool.query(UPDATE_STATUS_SQL, [
            artifactId,
            status,
            metadata.confidenceSignal === undefined
                ? null
                : JSON.stringify(metadata.confidenceSignal),
            metadata.deltasJson === undefined ? null : JSON.stringify(metadata.deltasJson),
            metadata.confirmedAt ?? null,
            metadata.confirmedByUser ?? null,
        ]);
        const row = result.rows[0];
        if (row === undefined) return null;
        return rowToArtifact(row as unknown as ArtifactRow);
    };

    return {
        setup,
        claimDocumentLock,
        findArtifactByDocumentHash,
        insertArtifact,
        updateArtifactStatus,
    };
};
