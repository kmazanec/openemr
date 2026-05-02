import type { BriefingState, BriefingStateUpdate } from '../state.js';
import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_PRESCRIPTIONS_UNAVAILABLE,
    isStoppedCategory,
} from '../../verify/verifier.js';
import { generateFollowUps } from '../followUps.js';
import type {
    AssistantMessage,
    AssistantMessageSegment,
    Claim,
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
        gaps: collectGaps(verified),
        suggestedFollowUps,
    };

    return { formatted };
};
