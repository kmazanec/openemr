import type { BriefingState, BriefingStateUpdate } from '../state.js';

/**
 * §3.2 stub. ARCHITECTURE.md §"Node Responsibilities" defines this node as
 * "Load conversation history and patient-bound context from Postgres" —
 * the substantive work lands in Phase 3.5 (conversation persistence).
 * For UC1 path, leaving state alone is correct: the envelope already
 * carries the patient identity the rest of the graph needs.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; stub body has no awaits yet.
export const loadState = async (_state: BriefingState): Promise<BriefingStateUpdate> => {
    return {};
};
