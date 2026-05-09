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

export type DocumentType = 'lab_pdf' | 'intake_form' | 'referral_letter';

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
    readonly claimDocumentLock: (
        documentUuid: string,
        options?: { readonly timeoutMs?: number },
    ) => Promise<DocumentLockHandle>;
    readonly findArtifactByDocumentHash: (
        documentHash: string,
        extractorVersion: string,
    ) => Promise<ExtractionArtifact | null>;
    /**
     * F.5a read helper for the `accept_fact` middleman route.
     * Returns the canonical artifact row (incl. `schemaJson`) so the
     * route can materialize the per-type promotion payload without
     * paying for a `searchArtifacts` scan. Returns null on miss; the
     * route surfaces that as 404 to the panel.
     */
    readonly findArtifactById: (artifactId: string) => Promise<ExtractionArtifact | null>;
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
    /**
     * §C.1 read helper for the conversational graph's
     * `documentEvidenceRetriever`. Returns artifacts in `pid`'s active
     * status set (`pending_confirmation` | `confirmed`), created on or
     * after `since`, optionally narrowed by `docTypes`. Rows arrive
     * `created_at DESC` so the retriever's recency-weighted ranking has
     * the freshest artifact at index 0.
     */
    readonly searchArtifacts: (
        filters: SearchArtifactsFilters,
    ) => Promise<readonly ExtractionArtifact[]>;
    /**
     * §F.3 record (or no-op-on-conflict) a per-fact disposition. When
     * the existing row's status differs from the requested status, the
     * existing row wins — already-accepted stays accepted — and a
     * structured warning is logged. When `expectedFactPaths` is
     * supplied and every path in the set now has a non-`pending`
     * disposition, the artifact-level status auto-rolls (all-accepted
     * → `confirmed`, all-rejected → `rejected`, mixed →
     * `pending_confirmation`).
     */
    readonly recordDisposition: (
        input: RecordDispositionInput,
    ) => Promise<RecordDispositionResult>;
    /** §F.3 fetch every disposition row for an artifact, sorted by `field_path`. */
    readonly getDispositions: (
        artifactId: string,
    ) => Promise<readonly FactDisposition[]>;
}

/**
 * §C.1 filter shape for {@link ExtractionArtifactStore.searchArtifacts}.
 * `pid` is non-negotiable and `since` is required — the retriever is
 * never allowed to widen patient scope or scan the whole table. The
 * status set is fixed at the active subset (`pending_confirmation`,
 * `confirmed`); rejected/superseded/failed artifacts are excluded so
 * the retriever doesn't surface stale or refused facts.
 */
export interface SearchArtifactsFilters {
    readonly pid: number;
    readonly since: Date;
    readonly docTypes?: readonly DocumentType[];
}

const SEARCHABLE_STATUSES: readonly ArtifactStatus[] = [
    'pending_confirmation',
    'confirmed',
];

/**
 * §F.3 Per-fact disposition status. Tracks accept/reject for each
 * cited field on an artifact independently of the artifact-level
 * `ArtifactStatus`, so the UI can render "5 facts accepted, 2
 * rejected, 3 pending" within a single artifact and the artifact-level
 * status auto-rolls only when every expected fact has been
 * dispositioned.
 *
 * `pending` is included as an explicit row state for parity with
 * future UI affordances (e.g. "defer this fact"); the common case is
 * callers writing `accepted` or `rejected` directly.
 */
export type FactDispositionStatus = 'accepted' | 'rejected' | 'pending';

const KNOWN_DISPOSITION_STATUSES: ReadonlySet<FactDispositionStatus> = new Set<
    FactDispositionStatus
>(['accepted', 'rejected', 'pending']);

export interface FactDisposition {
    readonly artifactId: string;
    readonly fieldPath: string;
    readonly status: FactDispositionStatus;
    readonly acceptedAt: string | null;
    readonly acceptedByUser: string | null;
}

export interface RecordDispositionInput {
    readonly artifactId: string;
    readonly fieldPath: string;
    readonly status: FactDispositionStatus;
    readonly userId: string;
    /** ISO timestamp. Falls back to `now()` in the SQL when omitted. */
    readonly acceptedAt?: string;
    /**
     * Full set of cited field paths the UI surfaced for this artifact.
     * When supplied, `recordDisposition` evaluates whether every
     * expected path now has a non-`pending` disposition; if yes, it
     * auto-rolls the artifact-level status (`confirmed` /
     * `rejected` / mixed → stays `pending_confirmation`).
     *
     * Omit this when you don't want the auto-roll — e.g. a partial
     * pre-flight write that the caller will reconcile later.
     */
    readonly expectedFactPaths?: readonly string[];
}

export interface RecordDispositionResult {
    readonly disposition: FactDisposition;
    /**
     * The artifact-level status the auto-roll transitioned to, or
     * `null` when nothing rolled (mixed dispositions, incomplete vs.
     * `expectedFactPaths`, or the caller omitted `expectedFactPaths`).
     */
    readonly artifactStatusRolledTo: ArtifactStatus | null;
}

// Schema lives in `agent/migrations/`:
//   1700000006000_baseline_extraction_artifacts.sql        — §B.1 table.
//   1700000007000_extracted_fact_dispositions.sql          — §F.3 sibling table.

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

const FIND_BY_ID_SQL = `
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
    WHERE artifact_id = $1
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

/**
 * §C.1 search query. Built without `doc_type` filtering — that fragment
 * is appended at call time when `docTypes` is supplied, so the SQL stays
 * sargable on the `(pid, doc_type, status)` index when the filter is
 * present and on `(pid, created_at)` when it isn't. The status array is
 * passed as a literal parameter so the query plan is stable across
 * callers.
 */
const SEARCH_SELECT_SQL = `
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
    WHERE pid = $1
      AND status = ANY($2)
      AND created_at >= $3
`;
const SEARCH_DOC_TYPE_PREDICATE = ' AND doc_type = ANY($4)';
const SEARCH_ORDER_BY = ' ORDER BY created_at DESC';

/**
 * §F.3 disposition queries. The SELECT-existing read protects the
 * already-accepted-stays-accepted invariant; the UPSERT-on-fresh-row
 * is conditional on that read returning nothing. The SELECT-all read
 * powers both `getDispositions` and the post-upsert auto-roll
 * computation. The status column is constrained at the application
 * layer (parsed via `parseDispositionStatus`); we keep it `VARCHAR`
 * rather than a Postgres `enum` so adding a future status doesn't
 * require a schema migration.
 */
const DISPOSITION_SELECT_ROW_SQL = `
    SELECT
        artifact_id,
        field_path,
        status,
        accepted_at,
        accepted_by_user
    FROM extracted_fact_dispositions
    WHERE artifact_id = $1 AND field_path = $2
    LIMIT 1
`;

const DISPOSITION_INSERT_SQL = `
    INSERT INTO extracted_fact_dispositions (
        artifact_id, field_path, status, accepted_at, accepted_by_user
    ) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5)
    ON CONFLICT (artifact_id, field_path) DO NOTHING
    RETURNING
        artifact_id,
        field_path,
        status,
        accepted_at,
        accepted_by_user
`;

const DISPOSITION_SELECT_ALL_SQL = `
    SELECT
        artifact_id,
        field_path,
        status,
        accepted_at,
        accepted_by_user
    FROM extracted_fact_dispositions
    WHERE artifact_id = $1
    ORDER BY field_path
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

interface DispositionRow {
    readonly artifact_id: string;
    readonly field_path: string;
    readonly status: string;
    readonly accepted_at: Date | string | null;
    readonly accepted_by_user: string | null;
}

const parseDocType = (raw: string): DocumentType => {
    if (raw === 'lab_pdf' || raw === 'intake_form') return raw;
    throw new Error(`unexpected doc_type from extraction_artifacts row: ${raw}`);
};

const parseStatus = (raw: string): ArtifactStatus => {
    if (KNOWN_STATUSES.has(raw as ArtifactStatus)) return raw as ArtifactStatus;
    throw new Error(`unexpected status from extraction_artifacts row: ${raw}`);
};

const parseDispositionStatus = (raw: string): FactDispositionStatus => {
    if (KNOWN_DISPOSITION_STATUSES.has(raw as FactDispositionStatus)) {
        return raw as FactDispositionStatus;
    }
    throw new Error(`unexpected status from extracted_fact_dispositions row: ${raw}`);
};

const toIsoString = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : value;

const rowToDisposition = (row: DispositionRow): FactDisposition => ({
    artifactId: row.artifact_id,
    fieldPath: row.field_path,
    status: parseDispositionStatus(row.status),
    acceptedAt: row.accepted_at === null ? null : toIsoString(row.accepted_at),
    acceptedByUser: row.accepted_by_user,
});

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

    const findArtifactById = async (
        artifactId: string,
    ): Promise<ExtractionArtifact | null> => {
        const result = await pool.query(FIND_BY_ID_SQL, [artifactId]);
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

    const searchArtifacts = async (
        filters: SearchArtifactsFilters,
    ): Promise<readonly ExtractionArtifact[]> => {
        if (filters.docTypes?.length === 0) {
            // The supervisor's narrowing rejects this upstream, but a
            // direct caller could still hit it — defending here keeps
            // the empty-set semantics ("matches nothing") from quietly
            // expanding into "matches everything".
            throw new Error(
                'searchArtifacts: docTypes must be non-empty when supplied (omit the field for "all")',
            );
        }
        const sql = filters.docTypes === undefined
            ? SEARCH_SELECT_SQL + SEARCH_ORDER_BY
            : SEARCH_SELECT_SQL + SEARCH_DOC_TYPE_PREDICATE + SEARCH_ORDER_BY;
        const params: unknown[] = [
            filters.pid,
            SEARCHABLE_STATUSES,
            filters.since.toISOString(),
        ];
        if (filters.docTypes !== undefined) {
            params.push(filters.docTypes);
        }
        const result = await pool.query(sql, params);
        return result.rows.map((r) => rowToArtifact(r as unknown as ArtifactRow));
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

    const getDispositions = async (
        artifactId: string,
    ): Promise<readonly FactDisposition[]> => {
        const result = await pool.query(DISPOSITION_SELECT_ALL_SQL, [artifactId]);
        return result.rows.map((r) => rowToDisposition(r as unknown as DispositionRow));
    };

    /**
     * Compute the artifact-level rollup target from a complete
     * disposition set. The "complete" predicate is the caller's
     * `expectedFactPaths` set being a subset of the dispositioned
     * paths and every dispositioned path being non-`pending`.
     */
    const computeRollupTarget = (
        dispositions: readonly FactDisposition[],
        expected: readonly string[],
    ): { target: ArtifactStatus; confirmedAt: string; confirmedByUser: string | null } | null => {
        const dispositionedPaths = new Set(dispositions.map((d) => d.fieldPath));
        for (const path of expected) {
            if (!dispositionedPaths.has(path)) return null;
        }
        // Filter to only the expected set so a stray extra disposition
        // doesn't taint the rollup. (UI surfacing is the source of
        // truth for "what counts.")
        const relevant = dispositions.filter((d) => expected.includes(d.fieldPath));
        if (relevant.some((d) => d.status === 'pending')) return null;
        const allAccepted = relevant.every((d) => d.status === 'accepted');
        const allRejected = relevant.every((d) => d.status === 'rejected');
        if (!allAccepted && !allRejected) return null; // mixed → stays pending_confirmation
        const target: ArtifactStatus = allAccepted ? 'confirmed' : 'rejected';
        // Use the most recent acceptedAt as the confirmedAt floor.
        // Fall back to "now" if every relevant row lacks one.
        const acceptedAtCandidates = relevant
            .map((d) => d.acceptedAt)
            .filter((a): a is string => a !== null);
        const confirmedAt = acceptedAtCandidates.length > 0
            ? acceptedAtCandidates.sort().at(-1) ?? new Date().toISOString()
            : new Date().toISOString();
        // Pick a single reviewer to record on the artifact: the user
        // who dispositioned the last (sorted) row. If multiple
        // clinicians touched the artifact this is a known imprecision —
        // per-fact reviewer remains accurate on the disposition rows.
        const lastByPath = [...relevant].sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));
        const confirmedByUser = lastByPath.at(-1)?.acceptedByUser ?? null;
        return { target, confirmedAt, confirmedByUser };
    };

    const recordDisposition = async (
        input: RecordDispositionInput,
    ): Promise<RecordDispositionResult> => {
        if (input.fieldPath.length === 0) {
            throw new Error('recordDisposition: fieldPath must be non-empty');
        }

        // Step 1: read existing row to enforce the "already-accepted
        // stays accepted" invariant. The status column is application-
        // managed, so we don't try to express the invariant in the
        // schema (which would force a CASE-heavy ON CONFLICT clause).
        const existingResult = await pool.query(DISPOSITION_SELECT_ROW_SQL, [
            input.artifactId,
            input.fieldPath,
        ]);
        const existingRow = existingResult.rows[0];
        let disposition: FactDisposition;
        if (existingRow === undefined) {
            // Step 2a: fresh insert. ON CONFLICT DO NOTHING is a
            // belt-and-suspenders against a concurrent write that
            // landed between our SELECT and INSERT — we re-read in
            // that case rather than hold a row lock.
            const insertResult = await pool.query(DISPOSITION_INSERT_SQL, [
                input.artifactId,
                input.fieldPath,
                input.status,
                input.acceptedAt ?? null,
                input.userId,
            ]);
            const insertedRow = insertResult.rows[0];
            if (insertedRow !== undefined) {
                disposition = rowToDisposition(insertedRow as unknown as DispositionRow);
            } else {
                // Concurrent writer beat us; re-read the row to get
                // the canonical state.
                const reread = await pool.query(DISPOSITION_SELECT_ROW_SQL, [
                    input.artifactId,
                    input.fieldPath,
                ]);
                const rereadRow = reread.rows[0];
                if (rereadRow === undefined) {
                    throw new Error(
                        'recordDisposition: race lost re-read returned no row',
                    );
                }
                disposition = rowToDisposition(rereadRow as unknown as DispositionRow);
            }
        } else {
            disposition = rowToDisposition(existingRow as unknown as DispositionRow);
            if (disposition.status !== input.status) {
                logger.warn(
                    {
                        artifactId: input.artifactId,
                        fieldPath: input.fieldPath,
                        existingStatus: disposition.status,
                        attemptedStatus: input.status,
                    },
                    'recordDisposition: refusing to overwrite existing disposition',
                );
            }
        }

        // Step 3: optional auto-roll. When the caller didn't pass
        // `expectedFactPaths` the read+update cost is wasted, so skip
        // it. When they did, evaluate completeness and roll.
        if (input.expectedFactPaths === undefined || input.expectedFactPaths.length === 0) {
            return { disposition, artifactStatusRolledTo: null };
        }
        const all = await getDispositions(input.artifactId);
        const rollup = computeRollupTarget(all, input.expectedFactPaths);
        if (rollup === null) {
            return { disposition, artifactStatusRolledTo: null };
        }
        const updated = await updateArtifactStatus(input.artifactId, rollup.target, {
            confirmedAt: rollup.confirmedAt,
            ...(rollup.confirmedByUser !== null
                ? { confirmedByUser: rollup.confirmedByUser }
                : {}),
        });
        return {
            disposition,
            artifactStatusRolledTo: updated?.status ?? rollup.target,
        };
    };

    return {
        claimDocumentLock,
        findArtifactByDocumentHash,
        findArtifactById,
        insertArtifact,
        updateArtifactStatus,
        searchArtifacts,
        recordDisposition,
        getDispositions,
    };
};
