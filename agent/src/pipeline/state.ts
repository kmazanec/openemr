/**
 * §B.3 Pipeline state shape.
 *
 * The ingestion pipeline is a separate compiled LangGraph app
 * (W2_ARCHITECTURE.md §"Pipeline as a compiled LangGraph app"). It is
 * short-lived and idempotent on `(document_hash, extractor_version)`,
 * so it does not use the LangGraph Postgres checkpointer — state lives
 * in memory for a single invocation.
 *
 * Six nodes share this state in order:
 *   rasterize → vision → schemaValidate → patientMatch → persist → emitDeltas
 *
 * Each node reduces the state by adding fields it owns. Nodes never
 * delete fields a previous node wrote; failure transitions set
 * `status = 'failed'` and append to `errors[]`, leaving downstream
 * nodes free to short-circuit on the failed status.
 */

import type { DocumentType } from '../state/extractionArtifacts.js';

export type PipelineStatus =
    | 'pending'
    | 'rasterized'
    | 'extracted'
    | 'validated'
    | 'matched'
    | 'persisted'
    | 'failed';

export type TriggerSource = 'panel' | 'autosweep' | 'cli';

export type PipelineErrorCode =
    | 'cost-cap-exceeded'
    | 'rasterize_failed'
    | 'storage-unreachable'
    | 'rate-limited'
    | 'schema_invalid'
    | 'patient_mismatch'
    | 'persist_failed';

export interface PipelineError {
    readonly code: PipelineErrorCode;
    readonly message: string;
    /** Optional structured detail; never PHI. */
    readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * One rasterized page uploaded to the Spaces transient prefix and
 * referenced by short-TTL signed URL for the vision call.
 */
export interface PageImage {
    readonly pageNum: number;
    /** Spaces object key (e.g. `transient/<doc-uuid>/page-1.png`). */
    readonly key: string;
    /** Single-call, ≤5-min-TTL signed GET URL the vision API consumes. */
    readonly signedUrl: string;
    /** ISO-8601 timestamp at which the signed URL expires. */
    readonly expiresAt: string;
}

/**
 * Per-pipeline confidence signal produced by the `patientMatch` node
 * (B.6) and read downstream by `persist` (B.7) so the artifact row
 * carries the same disposition the verifier's hard-stops will check.
 *
 * `patientMatchScore` is the average of the per-axis scores
 * (`matchName` + `matchDob`), each in `{0, 0.5, 0.6, 1.0}`. A confident
 * mismatch (either axis at 0.0) routes through `failed/patient_mismatch`
 * and the signal is *not* recorded — the artifact's `failed` status is
 * the load-bearing signal in that path. A partial match (any non-1.0
 * axis with no axis at 0.0) records the signal with
 * `patientMatchPartial = true`.
 *
 * `demographicsWarnings` carries stable, non-PHI tokens
 * (`'name_partial_match'`, `'dob_off_by_one_day'`) that the verifier
 * and the Tier-2 row both consume — never the actual name/DOB strings.
 */
export interface ConfidenceSignal {
    readonly patientMatchScore: number;
    readonly patientMatchPartial: boolean;
    readonly demographicsWarnings: readonly string[];
}

/**
 * Complete pipeline state. The shape is the union of every field any
 * of the six nodes can write; nodes return `Partial<PipelineState>` and
 * LangGraph merges via the channel reducers configured on the graph.
 */
export interface PipelineState {
    /** Always present. The OpenEMR DocumentReference UUID. */
    readonly documentUuid: string;
    /** Always present. Determines which extraction schema is used. */
    readonly docType: DocumentType;
    /** Always present. The patient row id the pipeline is bound to. */
    readonly pid: number;
    /** Always present. Where the pipeline was triggered from. */
    readonly triggerSource: TriggerSource;
    /** Empty until `rasterize` writes; final length === page count on success. */
    readonly pages: readonly PageImage[];
    /** Set by `vision` (raw structured-output) and re-checked by `schemaValidate`. Null until vision runs. */
    readonly schema: unknown;
    /** Set by `persist` after the Tier-2 row is inserted (or cached id returned). */
    readonly artifactId: string | null;
    /** Set by `patientMatch` on confident-or-partial match; null on refuse or before the node runs. */
    readonly confidenceSignal: ConfidenceSignal | null;
    readonly status: PipelineStatus;
    readonly errors: readonly PipelineError[];
}

export const initialPipelineState = (input: {
    readonly documentUuid: string;
    readonly docType: DocumentType;
    readonly pid: number;
    readonly triggerSource: TriggerSource;
}): PipelineState => ({
    documentUuid: input.documentUuid,
    docType: input.docType,
    pid: input.pid,
    triggerSource: input.triggerSource,
    pages: [],
    schema: null,
    artifactId: null,
    confidenceSignal: null,
    status: 'pending',
    errors: [],
});
