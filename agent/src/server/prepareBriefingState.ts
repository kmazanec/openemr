import type { Logger } from 'pino';

import type {
    AssistantMessage,
    BriefingSnapshot,
    ClaimLedger,
    DocumentEvidenceArgs,
    DraftBriefing,
    EvidenceArgs,
    EvidenceRetrieverOutput,
    ExtractedFactSnippet,
    PersistedRecord,
    PriorTurnContext,
    RequestEnvelope,
    RetrieveChartArgs,
    SupervisorDecision,
    VerifiedLedger,
} from '../graph/types.js';
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
 * Behaviors:
 *  - `planContext`'s "unknown task fails loud" guard (defense-in-depth
 *    against an unknown-task envelope reaching the graph).
 *  - Project `conversation_messages` into a `priorTurnContext` slot on
 *    the seeded state. Default-briefing turns receive `{ turns: [] }`
 *    because the runner mints a fresh conversation row before this
 *    helper is called. Follow-ups receive the runner's window over the
 *    prior thread.
 *  - Reset every per-turn graph slot. The Postgres checkpointer keys
 *    state by `thread_id`, so a follow-up turn that reuses the
 *    conversation hydrates the prior turn's full state — including the
 *    incremented `retrieveChartCallCount` and the supervisor's
 *    iteration counters. Without an explicit reset here, the follow-up
 *    enters `retrieveChart` with `callCount > 0` and the node demands
 *    `retrieveChartArgs` that don't exist, throwing
 *    "subsequent invocation requires retrieveChartArgs". The fields
 *    listed below are exactly the per-turn outputs the graph produces;
 *    `priorTurnContext` is the only slot that legitimately carries
 *    forward and it's set explicitly above.
 *
 * The snapshot argument to `loadPriorContext` is `null` here because
 * the snapshot is built by the `retrieve` graph node *after* this
 * seed runs. Assistant-turn citations therefore project to
 * opaque-pointer mode (rawValue: null) — the supervisor still routes
 * on `source_type` and the synthesizer treats the citation as
 * already-trusted-but-value-less.
 */
export interface PreparedBriefingState {
    readonly envelope: RequestEnvelope;
    readonly priorTurnContext: PriorTurnContext;
    readonly snapshot: BriefingSnapshot | null;
    readonly draft: DraftBriefing | null;
    readonly claimLedger: ClaimLedger | null;
    readonly verified: VerifiedLedger | null;
    readonly formatted: AssistantMessage | null;
    readonly persisted: PersistedRecord | null;
    readonly retrieveChartCallCount: number;
    readonly retrieveChartArgs: RetrieveChartArgs | null;
    readonly documentEvidenceArgs: DocumentEvidenceArgs | null;
    readonly documentEvidenceSnippets: readonly ExtractedFactSnippet[] | null;
    readonly documentEvidenceArtifactConfidence: ReadonlyMap<string, unknown> | null;
    readonly evidenceRetrieverArgs: EvidenceArgs | null;
    readonly evidenceRetrieverOutput: EvidenceRetrieverOutput | null;
    readonly supervisorIterations: number;
    readonly supervisorDecisionHistory: readonly SupervisorDecision[];
    readonly capHit: boolean;
}

export interface PrepareBriefingStateInput {
    readonly envelope: RequestEnvelope;
    readonly conversationMessages?: ConversationMessagesStore;
    readonly logger?: Logger;
}

const buildPerTurnReset = (): Omit<PreparedBriefingState, 'envelope' | 'priorTurnContext'> => ({
    snapshot: null,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 0,
    retrieveChartArgs: null,
    documentEvidenceArgs: null,
    documentEvidenceSnippets: null,
    documentEvidenceArtifactConfidence: null,
    evidenceRetrieverArgs: null,
    evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false,
});

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
            ...buildPerTurnReset(),
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
        ...buildPerTurnReset(),
    };
};
