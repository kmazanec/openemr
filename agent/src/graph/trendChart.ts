import type {
    AssistantMessageTrendChart,
    AssistantMessageTrendPoint,
    BriefingSnapshot,
    Claim,
    LabHistorySeries,
    RequestEnvelope,
    VerifiedLedger,
} from './types.js';
import type { LabObservation } from '../snapshot/types.js';

/**
 * Trend-chart decision module.
 *
 * Produces an optional `AssistantMessageTrendChart` to attach to the
 * assistant turn. Three rules drive the decision; the strongest matching
 * rule wins, single chart only:
 *
 *   1. **fresh_lab_with_history.** A `lab` claim was accepted whose
 *      analyte already has ≥1 prior numeric observation in the snapshot
 *      (or ≥2 numeric points if the new value is non-numeric). This is
 *      the "extracted-document new lab vs. historical chart" path: the
 *      doctor uploads a PDF, we extract A1c=8.4, the snapshot has two
 *      prior A1c readings — we render the trend with the new point at
 *      the right edge so the comparison is visual, not just textual.
 *
 *   2. **follow_up_lab_question.** The envelope is a `follow_up` and the
 *      verified ledger contains at least one `lab` claim whose analyte
 *      already has ≥2 numeric observations in the snapshot. We do NOT
 *      require trend-style phrasing — "What's her A1c?", "Show me
 *      LDL", "How was her sodium last visit?" all qualify alongside
 *      "How is X trending?". The points threshold and single-chart
 *      cap do the gating; demanding a keyword on top would silently
 *      drop the chart on natural lookups even though the data is
 *      already there. Source-of-truth-agnostic: works whether the
 *      values came from a recent uploaded document, a clinic
 *      observation entered manually, or a labHistory pull.
 *
 *   3. **No chart.** Default. Default briefings without an accepted
 *      lab claim, snapshots without enough numeric history, and
 *      non-numeric-value series (`positive`, `trace`) all fall through
 *      so the bubble stays clean.
 *
 * Single-chart cap is structural: the function returns `AssistantMessageTrendChart |
 * null` — by construction the bubble cannot render two charts. If
 * multiple analytes qualify under rule 1, the most-recently-observed
 * one wins (priority hint for the typical use case: "the just-uploaded
 * PDF").
 *
 * Pure function. No I/O, no LLM. The caller (format node) is the only
 * place that calls this — keeps the decision auditable and trivially
 * testable. The decision is intentionally narrow: when in doubt, no
 * chart.
 */

const MIN_NUMERIC_POINTS = 2;

const MAX_POINTS = 24;

/**
 * Parse a lab `value` string into a finite number. Lab values are
 * preserved as strings so qualifiers (`<0.01`, `>500`, `positive`,
 * `trace`) survive the snapshot round-trip — but a chart needs
 * numerics. Strip a single leading `<` or `>` qualifier so a `<0.01`
 * still plots at 0.01 (clinically the most-conservative read), and
 * reject anything else.
 */
const parseLabNumber = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const stripped = trimmed.replace(/^[<>]\s*/, '');
    const n = Number(stripped);
    if (!Number.isFinite(n)) return null;
    return n;
};

const labToPoint = (lab: LabObservation): AssistantMessageTrendPoint | null => {
    if (lab.observedAt === null || lab.observedAt === '') return null;
    const value = parseLabNumber(lab.value);
    if (value === null) return null;
    return {
        observedAt: lab.observedAt,
        value,
        abnormal: lab.abnormalFlag !== null && lab.abnormalFlag !== '',
    };
};

const sortPointsAscending = (
    points: readonly AssistantMessageTrendPoint[],
): readonly AssistantMessageTrendPoint[] => {
    const copy = [...points];
    copy.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    return copy;
};

const labsArrayOrEmpty = (snapshot: BriefingSnapshot): readonly LabObservation[] => {
    const labs = snapshot.labs;
    if ('kind' in labs) return [];
    return labs;
};

const labHistoryOrNull = (snapshot: BriefingSnapshot): LabHistorySeries | null => {
    const lh = snapshot.labHistory;
    if (lh === null) return null;
    if ('kind' in lh) return null;
    return lh;
};

/**
 * Group all numeric observations sharing an analyte name (case-insensitive)
 * with the seed lab. Pulls from both the snapshot's `labs` array and the
 * `labHistory` slot when present.
 */
const collectSeriesForAnalyte = (
    analyte: string,
    snapshot: BriefingSnapshot,
): {
    readonly points: readonly AssistantMessageTrendPoint[];
    readonly unit: string | null;
    readonly referenceRange: string | null;
} => {
    const target = analyte.toLowerCase();
    const seen = new Map<string, AssistantMessageTrendPoint>();
    let unit: string | null = null;
    let referenceRange: string | null = null;

    const ingest = (lab: LabObservation): void => {
        if (lab.analyte.toLowerCase() !== target) return;
        const point = labToPoint(lab);
        if (point === null) return;
        // Dedupe by `observedAt` so labHistory + labs overlap doesn't
        // double-plot a point. Last write wins; both slots speak the
        // same ObservationAdapter shape so the value is identical.
        seen.set(point.observedAt, point);
        if (unit === null && lab.unit !== null) unit = lab.unit;
        if (referenceRange === null && lab.referenceRange !== null) {
            referenceRange = lab.referenceRange;
        }
    };

    for (const lab of labsArrayOrEmpty(snapshot)) ingest(lab);
    const lh = labHistoryOrNull(snapshot);
    if (lh !== null) {
        for (const lab of lh.observations) ingest(lab);
    }

    const sorted = sortPointsAscending(Array.from(seen.values()));
    // Cap to the most-recent N points so a 5-year trend doesn't render
    // as a wall of dots in the bubble. The clinician reads recent
    // motion first; older points are still visible in the chart record
    // section's lab list.
    const points = sorted.length > MAX_POINTS ? sorted.slice(-MAX_POINTS) : sorted;
    return { points, unit, referenceRange };
};

const labClaimAnalytes = (
    accepted: readonly Claim[],
    labs: readonly LabObservation[],
): readonly { readonly analyte: string; readonly observedAt: string | null; readonly claimId: string }[] => {
    const out: { analyte: string; observedAt: string | null; claimId: string }[] = [];
    for (const claim of accepted) {
        if (claim.category !== 'lab') continue;
        for (const ref of claim.sourceReferences) {
            const lab = labs.find((l) => l.source.source_id === ref.source_id);
            if (lab !== undefined) {
                out.push({ analyte: lab.analyte, observedAt: lab.observedAt, claimId: claim.id });
                break;
            }
        }
    }
    return out;
};

interface DecideTrendChartInput {
    readonly verified: VerifiedLedger;
    readonly snapshot: BriefingSnapshot;
    readonly envelope: RequestEnvelope;
}

/**
 * Single decision point. Returns at most one chart attachment, or
 * `null` when no rule fires. Order matters: the more specific
 * `fresh_lab_with_history` (a fresh extracted lab landing alongside
 * historical chart values) takes priority over the generic
 * `follow_up_lab_question` so a "how is A1c trending?" follow-up that
 * also cites a fresh upload still attributes to the upload-comparison
 * reason — the renderer can style or label them differently in the
 * future without re-shaping the wire.
 */
export const decideTrendChart = (
    input: DecideTrendChartInput,
): AssistantMessageTrendChart | null => {
    const labs = labsArrayOrEmpty(input.snapshot);
    const labClaims = labClaimAnalytes(input.verified.accepted, labs);
    if (labClaims.length === 0) return null;

    // Rule 1: fresh_lab_with_history. Pick the most-recently-observed
    // qualifying lab claim whose analyte has ≥ MIN_NUMERIC_POINTS
    // numeric observations on file. "Recent" is the proxy for "this
    // is the new data point the doctor wants to compare against
    // history" — the just-extracted PDF lands at `observedAt` ≈ today.
    // Skip rows with a null observedAt: without a date the row can't
    // be the "fresh" anchor.
    const datedCandidates = labClaims
        .filter((c) => c.observedAt !== null)
        .map((c) => ({ ...c, sortKey: c.observedAt ?? '' }));
    datedCandidates.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

    for (const candidate of datedCandidates) {
        const series = collectSeriesForAnalyte(candidate.analyte, input.snapshot);
        if (series.points.length < MIN_NUMERIC_POINTS) continue;
        return {
            analyte: candidate.analyte,
            unit: series.unit,
            referenceRange: series.referenceRange,
            points: series.points,
            reason: 'fresh_lab_with_history',
            groundedInClaimIds: [candidate.claimId],
        };
    }

    // Rule 2: follow_up_lab_question. Any follow-up turn whose verified
    // ledger contains a `lab` claim with ≥ MIN_NUMERIC_POINTS numeric
    // observations on file. No keyword check — "What's her A1c?",
    // "Show me LDL", and "How is X trending?" all qualify. The
    // numeric-points threshold + single-chart cap are the gates;
    // requiring trend-style phrasing on top would silently drop the
    // chart on natural lookup questions even though the data is
    // already there. Iterates ALL lab claims (not just the dated
    // candidates rule 1 used) — the cited row's own observedAt is
    // irrelevant here; what matters is whether the analyte's series
    // has enough points to plot.
    if (input.envelope.task !== 'follow_up') return null;

    for (const candidate of labClaims) {
        const series = collectSeriesForAnalyte(candidate.analyte, input.snapshot);
        if (series.points.length < MIN_NUMERIC_POINTS) continue;
        return {
            analyte: candidate.analyte,
            unit: series.unit,
            referenceRange: series.referenceRange,
            points: series.points,
            reason: 'follow_up_lab_question',
            groundedInClaimIds: [candidate.claimId],
        };
    }

    return null;
};
