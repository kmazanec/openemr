import type { RequestEnvelope } from '../graph/types.js';

/**
 * Runner-side seed for the briefing graph. Replaces the W1 graph nodes
 * `loadState` and `planContext`, which were pass-throughs that
 * W2_ARCHITECTURE.md §"Conversational graph" hoists out of the graph
 * (the runner now owns conversation persistence and envelope
 * validation). The graph itself starts at `retrieve` — A.4 renames it
 * to `retrieveChart`.
 *
 * For Phase A this helper carries forward the only behavior that the
 * deleted nodes had — `planContext`'s "unknown task fails loud" guard.
 * A.5 extends it to materialize `priorTurnContext` from
 * `conversation_messages`; A.7 threads the supervisor-state slots in.
 */
export interface PreparedBriefingState {
    readonly envelope: RequestEnvelope;
}

export const prepareBriefingState = (input: {
    readonly envelope: RequestEnvelope;
}): PreparedBriefingState => {
    const task = input.envelope.task;
    if (task !== 'default_briefing' && task !== 'follow_up') {
        throw new Error(`unknown task: ${String(task)}`);
    }
    return { envelope: input.envelope };
};
