/**
 * §A.5 runner-side prior-turn projection. Reads `conversation_messages`
 * for the resolved conversation, strips the trailing current-question
 * append, windows to the last K=5 turn pairs, and projects each row
 * into the asymmetric `PriorTurn` shape consumed by the supervisor
 * (A.7) and synthesizer (A.8).
 *
 * Mirrors `W2_ARCHITECTURE.md` §"Prior-turn context":
 *
 * - **Asymmetric replay.** User turns replay verbatim — pronoun
 *   referents and corrections are unrecoverable from data. Assistant
 *   turns replay as `{citations, facts}` only — prose is a derived
 *   rendering, threading it would pollute the synthesizer's
 *   structured-output channel and force replay of redaction notices.
 * - **Trailing-current-turn strip.** The runner already appended
 *   `envelope.question` to `conversation_messages` before invoking
 *   the graph (so a mid-flight failure leaves the question visible
 *   on resume). We strip the trailing user entry when its text
 *   equals `currentQuestion`; on mismatch we log a warning and don't
 *   strip — failing closed here would corrupt the next turn over a
 *   clock skew or an unexpected dual-write race.
 * - **Window.** Last K=5 turn pairs (≤10 messages), oldest-first.
 *   Hardcoded; no summarization until §6.1 cost counters say so.
 * - **Opaque-pointer fallback.** Each assistant citation is resolved
 *   against the supplied `snapshot` using the verifier's indexer;
 *   when the citation's `source_id` isn't in the current snapshot
 *   (a different turn looked at different data), `rawValue` is
 *   `null` and a debug event is logged. The supervisor still sees
 *   the citation; the synthesizer treats it as already-trusted but
 *   value-less.
 */

import type { Logger } from 'pino';

import type { BriefingSnapshot, PriorTurn, PriorTurnContext } from '../graph/types.js';
import type { SourceReference } from '../snapshot/types.js';
import { buildSnapshotIndex, resolveSourceReference } from '../verify/verifier.js';

import type { ConversationMessage } from './conversationMessages.js';

const WINDOW_PAIRS = 5;
const WINDOW_MESSAGES = WINDOW_PAIRS * 2;

export interface LoadPriorContextInput {
    readonly conversationId: string;
    readonly currentQuestion: string | null;
    readonly snapshot: BriefingSnapshot | null;
    readonly listForConversation: (conversationId: string) => Promise<readonly ConversationMessage[]>;
    readonly logger: Logger;
}

export const loadPriorContext = async (
    input: LoadPriorContextInput,
): Promise<PriorTurnContext> => {
    const { conversationId, currentQuestion, snapshot, listForConversation, logger } = input;

    const all = await listForConversation(conversationId);
    if (all.length === 0) {
        return { turns: [] };
    }

    // §"Trailing-current-turn strip": the runner appends the
    // current user question before invoking the graph (so a failed
    // turn still surfaces the question to the user on resume). We
    // remove that one entry here; mismatches log and continue.
    const stripped = stripTrailingCurrentTurn(all, currentQuestion, logger);

    // Oldest-first window. `slice(-N)` keeps the last N entries while
    // preserving the original order, which matches the architecture's
    // "oldest-first" replay shape.
    const windowed = stripped.slice(-WINDOW_MESSAGES);

    // Build the index lazily — empty snapshots (default-briefing
    // turns shouldn't reach here, but defense-in-depth) skip
    // resolution and fall through to opaque-pointer mode.
    const idx = snapshot === null ? null : buildSnapshotIndex(snapshot);

    const turns: PriorTurn[] = windowed.map((msg) => projectMessage(msg, idx, logger));
    return { turns };
};

const stripTrailingCurrentTurn = (
    messages: readonly ConversationMessage[],
    currentQuestion: string | null,
    logger: Logger,
): readonly ConversationMessage[] => {
    if (currentQuestion === null) {
        // Default-briefing turns have no current question; nothing to
        // strip. The runner only seeds `conversation_messages` with
        // the current user text on follow-ups.
        return messages;
    }
    const tail = messages[messages.length - 1];
    if (tail === undefined) return messages;
    if (tail.role !== 'user') {
        logger.warn(
            { tailRole: tail.role },
            'loadPriorContext: trailing message is not a user turn; expected runner pre-append',
        );
        return messages;
    }
    if (tail.text !== currentQuestion) {
        logger.warn(
            { tailLen: tail.text.length, currentLen: currentQuestion.length },
            'loadPriorContext: trailing user text does not match envelope.question; not stripping',
        );
        return messages;
    }
    return messages.slice(0, -1);
};

const projectMessage = (
    msg: ConversationMessage,
    idx: ReturnType<typeof buildSnapshotIndex> | null,
    logger: Logger,
): PriorTurn => {
    if (msg.role === 'user') {
        return { role: 'user', text: msg.text };
    }
    const citations: SourceReference[] = [];
    for (const segment of msg.message.segments) {
        for (const claim of segment.claims) {
            for (const ref of claim.sourceReferences) {
                citations.push(ref);
            }
        }
    }
    const facts = citations.map((ref) => {
        if (idx === null) {
            return { sourceRef: ref, rawValue: null };
        }
        const rawValue = resolveSourceReference(idx, ref);
        if (rawValue === null) {
            logger.debug(
                { source_type: ref.source_type, source_id: ref.source_id },
                'loadPriorContext: prior-turn citation not in current snapshot — opaque-pointer mode',
            );
        }
        return { sourceRef: ref, rawValue };
    });
    return { role: 'assistant', citations, facts };
};
