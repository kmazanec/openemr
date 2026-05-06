/**
 * §C.5 confidence hard-stop thresholds. Pinned per
 * `W2_ARCHITECTURE.md` §"Hard stops on extraction confidence (Q14)".
 *
 * The architecture pins the threshold at 0.7 self-reported plus zero
 * schema warnings plus full patient-match — "tuned against eval-suite
 * output". Both the default extraction threshold and the allergy
 * fail-closed threshold land here so a future tuning sweep changes one
 * file, and threshold-shifts (logged on every trace per the
 * architecture) read the same constant.
 *
 * Why two constants for the same number today: the architecture
 * explicitly carves out an allergy exception ("category-level
 * fail-closed"). When the eval-suite tuning sweep ships, the allergy
 * threshold may diverge from the default (a stricter bar for
 * safety-critical signals is the obvious direction). Keeping them
 * separate now avoids a rename-the-world refactor when that happens.
 */

/**
 * Default per-fact extraction confidence threshold. Below this combined
 * signal, a non-allergy claim drops with reason `low-confidence-extraction`.
 */
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Allergy-specific confidence threshold. A low-confidence allergy fact
 * on an intake form fires a category-level fail-closed (allergy +
 * medication content suppressed for the turn).
 */
export const ALLERGY_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Combined signal per `W2_ARCHITECTURE.md` §"Hard stops on extraction
 * confidence":
 *  - **`selfReported`**: VLM's self-reported per-field confidence
 *    (continuous, 0–1). `undefined` when the pipeline pre-dates B.4
 *    or the extractor declined to emit a number.
 *  - **`schemaWarningCount`**: count of schema-validation warnings on
 *    the artifact (required-field nullified, enum value didn't match).
 *    Boolean in spirit — any non-zero value flips the combined signal.
 *  - **`patientMatch`**: `full` when the pipeline's patientMatch node
 *    confirmed the demographics; `partial` for typo-shaped DOB or
 *    middle-initial differences (the architecture explicitly flags
 *    these as "feeds Q14 hard-stop logic in the verifier downstream").
 */
export interface ConfidenceSignal {
    readonly selfReported?: number;
    readonly schemaWarningCount: number;
    readonly patientMatch: 'full' | 'partial';
}

/**
 * Architecture rule: any one of the three signals failing marks the
 * field "low confidence." Returns true when a hard-stop should fire.
 *
 * Fail-closed default: a missing `selfReported` (the pipeline hasn't
 * emitted a number, e.g. when this verifier sees a pre-B.4 artifact)
 * is treated as low-confidence. The alternative — defaulting to high
 * confidence on missing signal — would silently promote claims whose
 * extraction quality the agent has no signal about.
 */
export const isLowConfidence = (signal: ConfidenceSignal): boolean => {
    if (signal.selfReported === undefined) return true;
    if (signal.selfReported < EXTRACTION_CONFIDENCE_THRESHOLD) return true;
    if (signal.schemaWarningCount > 0) return true;
    if (signal.patientMatch !== 'full') return true;
    return false;
};

/**
 * Forgiving parse of an artifact's `confidence_signal` JSONB column —
 * which the schema currently types as `unknown` because the B.4–B.6
 * pipeline hasn't pinned the shape yet (the parallel B-track work
 * lands the writer side). The verifier reads this column on every
 * call, so a tolerant parser keeps the contract loose at the seam:
 *
 *  - `null` / non-object → returns `null`. Caller (verifier) treats
 *    `null` as "no signal", which `isLowConfidence` resolves to
 *    low-confidence via the missing-`selfReported` fail-closed branch.
 *  - object with garbage `self_reported` (NaN, out-of-range, wrong
 *    type) → field is dropped, not coerced; the caller sees the same
 *    fail-closed shape.
 *  - object missing all signal fields → defaults
 *    (`schemaWarningCount: 0`, `patientMatch: 'full'`) so a future
 *    pipeline emitting only `self_reported` works cleanly.
 *  - unknown `patient_match` bucket → coerces to `partial` (fail-closed
 *    rather than silently treating an unrecognized value as full match).
 *
 * Accepts both snake_case (database column convention) and camelCase
 * (TS object convention) so a re-projection through `JSON.stringify`/
 * `JSON.parse` doesn't lose the signal.
 */
export const parseConfidenceSignal = (raw: unknown): ConfidenceSignal | null => {
    if (raw === null || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const selfRaw = obj['self_reported'] ?? obj['selfReported'];
    let selfReported: number | undefined;
    if (typeof selfRaw === 'number' && Number.isFinite(selfRaw) && selfRaw >= 0 && selfRaw <= 1) {
        selfReported = selfRaw;
    }

    const warnRaw = obj['schema_warning_count'] ?? obj['schemaWarningCount'];
    const schemaWarningCount =
        typeof warnRaw === 'number' && Number.isFinite(warnRaw) && warnRaw >= 0
            ? Math.floor(warnRaw)
            : 0;

    const matchRaw = obj['patient_match'] ?? obj['patientMatch'];
    const patientMatch: 'full' | 'partial' = matchRaw === 'full' ? 'full' : 'partial';
    // Defaulting an *absent* match to 'full' is the right call — the
    // pipeline only emits `partial` when the patientMatch node flagged
    // a difference, so absence means "no flag fired" which is the same
    // semantic as full match. An *unrecognized* string (e.g.
    // `'mystery-bucket'`) takes the partial branch via the ternary
    // above — fail-closed rather than silently treating an unknown
    // bucket as full.
    const matchResolved: 'full' | 'partial' =
        matchRaw === undefined ? 'full' : patientMatch;

    return selfReported === undefined
        ? { schemaWarningCount, patientMatch: matchResolved }
        : { selfReported, schemaWarningCount, patientMatch: matchResolved };
};
