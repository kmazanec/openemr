import type { BriefingState, BriefingStateUpdate } from '../state.js';

/**
 * ARCHITECTURE.md §"Node Responsibilities" defines this node as "Store
 * state, metadata, claim ledger, token usage, cost, and verification
 * result". Durability lives in two places:
 *   - LangGraph's Postgres checkpointer (§1.2 + §3.5) snapshots the full
 *     state machine on each transition, keyed by the canonical
 *     conversation id passed via `thread_id` from the runner.
 *   - The `conversations` row (§3.5) anchors the (user, patient,
 *     appointment?) tuple so subsequent chart opens resume the same
 *     thread instead of starting fresh.
 *
 * The node itself only emits a `persisted` marker so downstream code can
 * observe that the graph reached the terminal node. Claim-ledger and
 * cost persistence are deferred to a later phase.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; durable state lives in the LangGraph Postgres checkpointer (§1.2) and the conversations row (§3.5).
export const persist = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    return {
        persisted: {
            conversationId: state.envelope.conversationId,
            requestId: state.envelope.requestId,
            persistedAt: new Date().toISOString(),
        },
    };
};
