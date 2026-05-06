/**
 * Cross-suite rubric input shape — every eval target adapts its native
 * output into one of these so the five Week-2 boolean rubrics can
 * score any case from any suite uniformly.
 *
 * The five rubrics (`schema_valid`, `citation_present`,
 * `factually_consistent`, `safe_refusal`, `no_phi_in_logs`) read this
 * shape exclusively. Targets keep their native run-result shape for
 * suite-specific scoring; `rubricInput` is an additional projection.
 */

/** A claim the agent surfaced (verifier-accepted, with attached citations). */
export interface RubricClaim {
    readonly text: string;
    readonly category: string;
    /**
     * Each citation's `(source_type, source_id)` pair, plus an optional
     * locator hint. The rubric only checks the array is non-empty —
     * structural validity is the verifier's job.
     */
    readonly sourceReferences: readonly {
        readonly source_type: string;
        readonly source_id: string;
    }[];
}

/**
 * What the rubrics need to decide pass/fail per case. Suites build
 * one of these from their native run result and attach it to the
 * LangSmith-stored `outputs` under `rubricInput`.
 */
export interface AgentRubricInput {
    /**
     * Case kind drives which rubrics apply. `refusal` cases score
     * `safe_refusal`; non-refusal cases skip it. `pipeline` cases
     * (document extraction) score `schema_valid` against the parsed
     * pipeline output rather than the synthesizer claims.
     */
    readonly kind: 'briefing' | 'conversational' | 'pipeline' | 'refusal';

    /** Verifier-accepted claims. Empty for refusals and for failed pipelines. */
    readonly acceptedClaims: readonly RubricClaim[];

    /** Verifier-rejected claims. Empty when verifier passed cleanly. */
    readonly rejectedClaimCount: number;

    /** True iff the verifier returned `passed: true`. */
    readonly verifierPassed: boolean;

    /** Hard-stop tags emitted by the safety layer (e.g. `allergies-unavailable`). */
    readonly hardStops: readonly string[];

    /**
     * For pipeline cases: did the strict-schema parse succeed? For
     * non-pipeline cases this is `null` — the rubric falls back to
     * "did synthesizer output parse" which is implicit in
     * `acceptedClaims` being non-empty.
     */
    readonly schemaValid: boolean | null;

    /**
     * Closed-set refusal phrasing matched (e.g.
     * `out-of-scope-question`, `cross-patient-blocked`). Non-null
     * implies the case is a refusal and the response matches the
     * allowed refusal pattern.
     */
    readonly refusalPhraseMatch: string | null;

    /**
     * Free-text fields the `no_phi_in_logs` scanner walks (e.g.
     * accepted-claim text, formatted assistant message segments).
     * The scanner also walks the LangSmith trace body separately.
     */
    readonly scannedText: readonly string[];
}

/** All five rubric keys, in evaluator-emission order. */
export const RUBRIC_KEYS = [
    'schema_valid',
    'citation_present',
    'factually_consistent',
    'safe_refusal',
    'no_phi_in_logs',
] as const;

export type RubricKey = (typeof RUBRIC_KEYS)[number];
