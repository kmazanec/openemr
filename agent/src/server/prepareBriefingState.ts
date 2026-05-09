import type { Logger } from 'pino';

import { assembleFullSnapshot } from '../graph/nodes/retrieveChart.js';
import type {
    AssistantMessage,
    BriefingSnapshot,
    ClaimLedger,
    DocumentEvidenceArgs,
    DraftBriefing,
    EvidenceArgs,
    EvidenceRetrieverOutput,
    ExtractedFactSnippet,
    KickoffExtractionResult,
    PersistedRecord,
    PriorTurnContext,
    RequestEnvelope,
    RetrieveChartArgs,
    SupervisorDecision,
    VerifiedLedger,
} from '../graph/types.js';
import type { Counters } from '../observability/counters.js';
import { loadPriorContext } from '../state/loadPriorContext.js';
import type { ConversationMessagesStore } from '../state/conversationMessages.js';
import { loadChartSnapshot } from '../tools/loadChartSnapshot.js';
import type { SnapshotClient } from '../tools/snapshotClient.js';

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
    readonly kickoffExtractionResults: readonly KickoffExtractionResult[];
}

/**
 * Optional snapshot-prefetch deps. When supplied, `prepareBriefingState`
 * runs `loadChartSnapshot` in parallel with `loadPriorContext` so the
 * `retrieveChart` graph node has nothing to do on its first traversal —
 * the supervisor sees real chart context on iteration 1 without the
 * runner paying for a serialized HTTP hop. On prefetch failure we log
 * and fall through, leaving the graph to run `retrieveChart` as before.
 */
export interface SnapshotPrefetchDeps {
    readonly client: SnapshotClient;
    readonly token: string;
    readonly siteId: string;
    readonly counters?: Counters;
}

export interface PrepareBriefingStateInput {
    readonly envelope: RequestEnvelope;
    readonly conversationMessages?: ConversationMessagesStore;
    readonly logger?: Logger;
    readonly snapshotPrefetch?: SnapshotPrefetchDeps;
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
    // `kickoffExtractionResults` is a per-turn cursor (the supervisor
    // uses its membership to detect "already extracted this uuid this
    // turn"). The annotation defaults to `[]` but the LangGraph
    // checkpointer hydrates the prior turn's value across turns
    // because state is keyed by `thread_id` (= conversation id).
    // Without an explicit reset here the array accumulates across the
    // whole conversation and the synthesizer's extraction-follow-up
    // prompt sees "two failed" then "three failed" even when only
    // one new doc was attached.
    kickoffExtractionResults: [],
});

/**
 * Run the snapshot prefetch if deps are wired. Fails soft: a thrown
 * error from the snapshot endpoint becomes `null`, the graph then runs
 * `retrieveChart` against the same client and gets the real error
 * surface there. Logging the failure here at warn level gives the
 * operator a signal that prefetch isn't covering its share of the
 * latency budget, without changing user-visible behavior.
 */
const runPrefetch = async (
    deps: SnapshotPrefetchDeps | undefined,
    pid: number,
    logger: Logger | undefined,
): Promise<BriefingSnapshot | null> => {
    if (deps === undefined) return null;
    try {
        const chart = await loadChartSnapshot({
            client: deps.client,
            token: deps.token,
            siteId: deps.siteId,
            pid,
            ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
        });
        return assembleFullSnapshot(chart, null);
    } catch (err) {
        logger?.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'prepareBriefingState: snapshot prefetch failed; graph will retry in retrieveChart',
        );
        return null;
    }
};

export const prepareBriefingState = async (
    input: PrepareBriefingStateInput,
): Promise<PreparedBriefingState> => {
    const task = input.envelope.task;
    if (task !== 'default_briefing' && task !== 'follow_up') {
        throw new Error(`unknown task: ${String(task)}`);
    }

    // Default-briefing turns always start a fresh conversation row, so
    // there is by definition no prior context to load. Follow-ups
    // without a wired conversation store / logger likewise skip the
    // prior-turn projection (test-only path).
    const skipPriorContext =
        task === 'default_briefing'
        || input.conversationMessages === undefined
        || input.logger === undefined;

    const priorContextPromise: Promise<PriorTurnContext> = skipPriorContext
        ? Promise.resolve({ turns: [] })
        : loadPriorContext({
            conversationId: input.envelope.conversationId,
            currentQuestion: input.envelope.question ?? null,
            snapshot: null,
            listForConversation: input.conversationMessages.listForConversation,
            logger: input.logger,
        });

    const [priorTurnContext, prefetchedSnapshot] = await Promise.all([
        priorContextPromise,
        runPrefetch(input.snapshotPrefetch, input.envelope.patient.pid, input.logger),
    ]);

    const reset = buildPerTurnReset();
    return {
        envelope: input.envelope,
        priorTurnContext,
        ...reset,
        // When prefetch landed, hand the graph a populated snapshot and
        // bump the call counter so the `retrieveChart` node's no-op
        // fast-path triggers on its first traversal.
        ...(prefetchedSnapshot !== null
            ? { snapshot: prefetchedSnapshot, retrieveChartCallCount: 1 }
            : {}),
    };
};
