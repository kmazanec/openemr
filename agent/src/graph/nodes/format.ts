import type { BriefingState, BriefingStateUpdate } from '../state.js';
import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_PRESCRIPTIONS_UNAVAILABLE,
    isStoppedCategory,
} from '../../verify/verifier.js';
import { deriveArchetypeFlags } from '../archetypeFlags.js';
import { generateFollowUps } from '../followUps.js';
import type {
    AssistantMessage,
    AssistantMessageSegment,
    ChartGroupSubsection,
    Claim,
    ClaimCategory,
    ClaimGroups,
    DocumentClaimCard,
    DraftSegment,
    Gap,
    VerifiedLedger,
} from '../types.js';

/**
 * §3.2 + §3.3 implementation, reshaped for the §4.5 conversational UI.
 * Walks the synthesizer's segmented draft and the verified ledger and
 * produces a single `AssistantMessage` the §3.4 SSE renderer emits as one
 * event. The shape mirrors the chat bubble the UI renders: ordered prose
 * segments with their backing claims attached, plus message-level gaps
 * for safety hard stops.
 *
 * Per-segment behaviour:
 *
 *   1. Connector segments (empty `claimIds`) pass through unchanged.
 *   2. Segments whose every `claimId` resolves to an `accepted` claim
 *      pass through with the resolved claims attached.
 *   3. Segments with at least one missing or rejected `claimId` are
 *      redacted: text becomes the canonical "[content withheld — could
 *      not be verified]" notice and `claims` is empty. The original text
 *      is NOT shipped to the renderer — coherent fail-closed.
 *
 * Hard-stop behaviour mirrors §3.3: when the verifier reports
 * `allergies-unavailable` or `prescriptions-unavailable`, every
 * segment whose claims fall in the suppressed category is redacted,
 * and the gap is surfaced once at message level so the UI can render a
 * banner above the bubble.
 */

const REDACTION_TEXT = '[content withheld — could not be verified]';

const HARD_STOP_GAPS: Record<string, Gap> = {
    [HARD_STOP_ALLERGIES_UNAVAILABLE]: {
        kind: 'gap',
        reason: HARD_STOP_ALLERGIES_UNAVAILABLE,
        message: 'Allergy data is unavailable; prescription summary withheld.',
    },
    [HARD_STOP_PRESCRIPTIONS_UNAVAILABLE]: {
        kind: 'gap',
        reason: HARD_STOP_PRESCRIPTIONS_UNAVAILABLE,
        message: 'Prescription data is unavailable.',
    },
};

const redactedSegment = (): AssistantMessageSegment => ({
    text: REDACTION_TEXT,
    claims: [],
    redacted: true,
});

const formatSegment = (
    segment: DraftSegment,
    acceptedById: ReadonlyMap<string, Claim>,
    suppressedIds: ReadonlySet<string>,
    stops: readonly string[],
): AssistantMessageSegment => {
    if (segment.claimIds.length === 0) {
        // Connector segment — no factual content to verify.
        return { text: segment.text, claims: [], redacted: false };
    }

    const resolved: Claim[] = [];
    for (const id of segment.claimIds) {
        const claim = acceptedById.get(id);
        if (claim === undefined) {
            // Claim is missing from the ledger entirely OR was rejected
            // by the verifier. Either way the segment cannot be backed,
            // so redact the whole thing.
            return redactedSegment();
        }
        if (suppressedIds.has(id)) {
            return redactedSegment();
        }
        if (isStoppedCategory(claim.category, stops)) {
            return redactedSegment();
        }
        resolved.push(claim);
    }
    return { text: segment.text, claims: resolved, redacted: false };
};

const collectGaps = (verified: VerifiedLedger): readonly Gap[] => {
    const gaps: Gap[] = [];
    for (const stop of verified.safetyHardStops) {
        const gap = HARD_STOP_GAPS[stop];
        if (gap !== undefined) gaps.push(gap);
    }
    return gaps;
};

/**
 * Canonical W1 sub-section order inside the panel UI's "What's in the
 * chart" section. Mirrors the W1 `FormattedBriefing` ordering so the
 * panel renders diagnoses → meds → labs → … the way the W1 bubble used
 * to. Typed as `Record<ClaimCategory, number>` so the TypeScript exhaustiveness
 * check catches a future `ClaimCategory` addition that forgets to slot
 * itself into the order — without this, a new category would silently
 * disappear from the panel.
 */
const CHART_CATEGORY_RANK: Record<ClaimCategory, number> = {
    identity: 0,
    appointment: 1,
    encounter: 2,
    diagnosis: 3,
    prescription: 4,
    prescription_change: 5,
    medication_statement: 6,
    allergy: 7,
    lab: 8,
    reminder: 9,
};

/**
 * §C.6 panel-UI grouping. Buckets accepted claims by primary
 * `sourceReferences[0].source_type`:
 *   - `chart` → "What's in the chart" (sub-grouped by `Claim.category`).
 *   - `extracted_document` → "From documents" (sub-grouped by
 *     `meta.document_uuid`; one card per document).
 *   - `guideline` → "Evidence" (flat list).
 *
 * **Mixed-source claim placement.** When a claim carries multiple
 * `sourceReferences` with mixed `source_type`, the **primary** (first)
 * reference wins; the claim lands in exactly one section, never
 * duplicated across two. The synthesizer is steered to lead with the
 * most-load-bearing source for the assertion, so primary-wins is the
 * intent-preserving rule.
 *
 * **Hard-stop suppression.** A claim whose category is fully suppressed
 * by an active safety hard stop is filtered out before grouping so the
 * panel stays in sync with the redacted bubble.
 *
 * **Empty-section omission.** A bucket with zero claims is *absent* from
 * the returned object. The renderer treats `claimGroups.guideline ===
 * undefined` as "no Evidence section this turn" without an empty-list
 * branch.
 */
const groupClaims = (
    accepted: readonly Claim[],
    stops: readonly string[],
): ClaimGroups => {
    const chartByCategory = new Map<ClaimCategory, Claim[]>();
    const docByUuid = new Map<string | null, Claim[]>();
    const docOrder: (string | null)[] = [];
    const guideline: Claim[] = [];

    for (const claim of accepted) {
        if (isStoppedCategory(claim.category, stops)) continue;

        const primary = claim.sourceReferences[0];
        // Defensive — synthesizer schema requires ≥1 sourceReference per
        // claim. If somehow zero, drop the claim from the panel rather
        // than guess a bucket.
        if (primary === undefined) continue;

        switch (primary.source_type) {
            case 'chart': {
                const existing = chartByCategory.get(claim.category);
                if (existing === undefined) {
                    chartByCategory.set(claim.category, [claim]);
                } else {
                    existing.push(claim);
                }
                break;
            }
            case 'extracted_document': {
                const uuid = primary.meta?.document_uuid ?? null;
                const existing = docByUuid.get(uuid);
                if (existing === undefined) {
                    docByUuid.set(uuid, [claim]);
                    docOrder.push(uuid);
                } else {
                    existing.push(claim);
                }
                break;
            }
            case 'guideline': {
                guideline.push(claim);
                break;
            }
        }
    }

    const groups: { -readonly [K in keyof ClaimGroups]: ClaimGroups[K] } = {};

    if (chartByCategory.size > 0) {
        const subsections: ChartGroupSubsection[] = Array.from(chartByCategory.entries())
            .map(([category, claims]) => ({ category, claims }))
            .sort((a, b) => CHART_CATEGORY_RANK[a.category] - CHART_CATEGORY_RANK[b.category]);
        groups.chart = { subsections };
    }

    if (docByUuid.size > 0) {
        const cards: DocumentClaimCard[] = docOrder.map((uuid) => ({
            documentUuid: uuid,
            claims: docByUuid.get(uuid) ?? [],
        }));
        groups.extractedDocument = { cards };
    }

    if (guideline.length > 0) {
        groups.guideline = { claims: guideline };
    }

    return groups;
};

// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; node body has no awaits.
export const format = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    if (state.verified === null) {
        throw new Error('Format called before Verify ran');
    }
    if (state.snapshot === null) {
        throw new Error('Format called without a snapshot');
    }
    if (state.draft === null) {
        throw new Error('Format called before Synthesize produced a draft');
    }

    const verified = state.verified;
    const draft = state.draft;

    const acceptedById = new Map<string, Claim>();
    for (const claim of verified.accepted) {
        acceptedById.set(claim.id, claim);
    }

    // Suppression-by-id is a future hook: the verifier today only signals
    // category-level hard stops, but a per-claim suppression set lets us
    // tighten the gate without reshaping `format` later. Empty in §4.5.
    const suppressedIds: ReadonlySet<string> = new Set<string>();

    const segments: AssistantMessageSegment[] = draft.segments.map((segment) =>
        formatSegment(segment, acceptedById, suppressedIds, verified.safetyHardStops),
    );

    // Suggested follow-ups are the chip set that powers the next user
    // turn — they make sense only on the default briefing. A follow-up
    // turn answering an earlier chip would otherwise emit a stale chip
    // set re-derived from the previous question's verifier output;
    // suppress at source so the UI never sees a chip whose origin chip
    // it can't trace back to a default_briefing turn.
    const suggestedFollowUps = state.envelope.task === 'default_briefing'
        ? generateFollowUps(state.envelope.conversationId, verified, state.snapshot)
        : [];

    const formatted: AssistantMessage = {
        segments,
        claimGroups: groupClaims(verified.accepted, verified.safetyHardStops),
        gaps: collectGaps(verified),
        suggestedFollowUps,
        archetypeFlags: deriveArchetypeFlags(state.snapshot),
    };

    return { formatted };
};
