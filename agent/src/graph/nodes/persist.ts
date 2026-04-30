import type { BriefingState, BriefingStateUpdate } from '../state.js';

/**
 * §3.2 stub. ARCHITECTURE.md §"Node Responsibilities" defines this node
 * as "Store state, metadata, claim ledger, token usage, cost, and
 * verification result". The LangGraph Postgres checkpointer (wired in
 * §1.2) already snapshots the full state machine on each transition,
 * which covers the durability half. Phase 3.5 lands the `conversation`
 * row + claim-ledger persistence on top.
 *
 * For now we record a minimal `persisted` marker so downstream tests
 * can observe the node ran.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; durable state lives in the LangGraph Postgres checkpointer (§1.2). Phase 3.5 adds the conversation row.
export const persist = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    return {
        persisted: {
            conversationId: state.envelope.conversationId,
            requestId: state.envelope.requestId,
            persistedAt: new Date().toISOString(),
        },
    };
};
