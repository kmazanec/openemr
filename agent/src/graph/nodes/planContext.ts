import type { BriefingState, BriefingStateUpdate } from '../state.js';

/**
 * §3.2 thin gate. ARCHITECTURE.md §"Node Responsibilities" defines this
 * node as "Classify default briefing vs. follow-up and determine needed
 * chart categories". UC1 (default_briefing) needs every category, so
 * `Retrieve` calls all four §3.1 tools unconditionally for now. Phase 4
 * adds the follow-up path which will narrow the category set per task.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; stub body has no awaits yet.
export const planContext = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    const task = state.envelope.task;
    if (task !== 'default_briefing' && task !== 'follow_up') {
        throw new Error(`unknown task: ${String(task)}`);
    }
    return {};
};
