import type { Logger } from 'pino';

import type { PriorTurnContext, RequestEnvelope } from '../graph/types.js';
import { loadPriorContext } from '../state/loadPriorContext.js';
import type { ConversationMessagesStore } from '../state/conversationMessages.js';

/**
 * Runner-side seed for the briefing graph. Replaces the W1 graph nodes
 * `loadState` and `planContext`, which were pass-throughs that
 * W2_ARCHITECTURE.md §"Conversational graph" hoists out of the graph
 * (the runner now owns conversation persistence and envelope
 * validation). The graph itself starts at `retrieve` — A.4 renames it
 * to `retrieveChart`.
 *
 * Phase A behaviors:
 *  - `planContext`'s "unknown task fails loud" guard (defense-in-depth
 *    against an unknown-task envelope reaching the graph).
 *  - §A.5: project `conversation_messages` into a `priorTurnContext`
 *    slot on the seeded state. Default-briefing turns receive
 *    `{ turns: [] }` because the runner mints a fresh conversation
 *    row before this helper is called. Follow-ups receive the
 *    runner's window over the prior thread.
 *
 * The snapshot argument to `loadPriorContext` is `null` here because
 * the snapshot is built by the `retrieve` graph node *after* this
 * seed runs. Assistant-turn citations therefore project to
 * opaque-pointer mode (rawValue: null) — the supervisor still routes
 * on `source_type` and the synthesizer treats the citation as
 * already-trusted-but-value-less. A future sub-phase (A.7/A.8 or
 * later) can re-resolve facts once the snapshot is available.
 *
 * A.7 will thread the supervisor-state slots in.
 */
export interface PreparedBriefingState {
    readonly envelope: RequestEnvelope;
    readonly priorTurnContext: PriorTurnContext;
}

export interface PrepareBriefingStateInput {
    readonly envelope: RequestEnvelope;
    readonly conversationMessages?: ConversationMessagesStore;
    readonly logger?: Logger;
}

export const prepareBriefingState = async (
    input: PrepareBriefingStateInput,
): Promise<PreparedBriefingState> => {
    const task = input.envelope.task;
    if (task !== 'default_briefing' && task !== 'follow_up') {
        throw new Error(`unknown task: ${String(task)}`);
    }

    // Default-briefing turns always start a fresh conversation row, so
    // there is by definition no prior context to load.
    if (
        task === 'default_briefing'
        || input.conversationMessages === undefined
        || input.logger === undefined
    ) {
        return {
            envelope: input.envelope,
            priorTurnContext: { turns: [] },
        };
    }

    const priorTurnContext = await loadPriorContext({
        conversationId: input.envelope.conversationId,
        currentQuestion: input.envelope.question ?? null,
        snapshot: null,
        listForConversation: input.conversationMessages.listForConversation,
        logger: input.logger,
    });

    return {
        envelope: input.envelope,
        priorTurnContext,
    };
};
