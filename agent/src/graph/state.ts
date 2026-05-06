import { Annotation } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

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
} from './types.js';

/**
 * Plan §3.2 state shape: `{envelope, snapshot, draft, claimLedger,
 * verified, formatted, persisted}`. Each downstream node populates its
 * own slot — `draft` carries the synthesizer's segmented prose and the
 * structured `claimLedger` so `Verify` can score the latter and `Format`
 * can resolve segment claim ids against the former. Defaults are null so
 * a partially-run graph state is recognizable.
 *
 * Slots use `LastValue<T>` directly rather than `Annotation<T>({reducer,
 * default})`. The latter wraps the Update type as `T | OverwriteValue<T>`
 * which leaks into every node return type and confuses both TS narrowing
 * and ESLint's safe-member-access rule. `LastValue<T>(factory)` gives the
 * same last-write-wins semantics with `Update = T`.
 */
const lastValueChannel = <T>(factory: () => T): (() => LastValue<T>) =>
    () => new LastValue<T>(factory);

export const BriefingStateAnnotation = Annotation.Root({
    envelope: Annotation<RequestEnvelope>,
    // §A.5: runner-prepared prior-turn dialog memory. Default-briefing
    // turns receive `{ turns: [] }`; follow-ups receive the projected
    // last K=5 turn pairs from `conversation_messages`. Both the
    // supervisor (A.7) and synthesizer (A.8) read this slot.
    priorTurnContext: lastValueChannel<PriorTurnContext>(() => ({ turns: [] })),
    snapshot: lastValueChannel<BriefingSnapshot | null>(() => null),
    draft: lastValueChannel<DraftBriefing | null>(() => null),
    claimLedger: lastValueChannel<ClaimLedger | null>(() => null),
    verified: lastValueChannel<VerifiedLedger | null>(() => null),
    formatted: lastValueChannel<AssistantMessage | null>(() => null),
    persisted: lastValueChannel<PersistedRecord | null>(() => null),
    /**
     * §A.4 retrieveChart call counter. The first invocation (count === 0)
     * runs the deterministic W1 fan-out so the supervisor has chart
     * context on iteration 1; subsequent invocations honor the
     * supervisor's `retrieveChartArgs.categories`. Incremented by the
     * node on entry.
     */
    retrieveChartCallCount: lastValueChannel<number>(() => 0),
    /**
     * §A.4 supervisor handoff args for `retrieveChart`. Null on the first
     * call (deterministic fan-out); A.7 supervisor sets this before each
     * subsequent invocation. Empty `categories` is rejected at the node
     * entry; the supervisor's structured-output schema enforces the same
     * upstream once A.7 lands.
     */
    retrieveChartArgs: lastValueChannel<RetrieveChartArgs | null>(() => null),
    /**
     * §C.1 supervisor handoff args for `documentEvidenceRetriever`.
     * Null until the supervisor picks the handoff with structured args;
     * narrowed against `DocumentEvidenceArgsSchema` before reaching this
     * slot so the node can trust the shape. Persisted across iterations
     * so a cycle-warning sink can compare arg payloads.
     */
    documentEvidenceArgs: lastValueChannel<DocumentEvidenceArgs | null>(() => null),
    /**
     * §C.1 retriever output: the snippets `documentEvidenceRetriever`
     * returns for the supervisor's next iteration to reason over and
     * (eventually) for the C.5 verifier to resolve `extracted_document`
     * citations against. Empty array is the legitimate "no matching
     * artifacts" signal — distinct from `null` (retriever has not run
     * this turn).
     */
    documentEvidenceSnippets: lastValueChannel<readonly ExtractedFactSnippet[] | null>(
        () => null,
    ),
    /**
     * §C.3 supervisor handoff args for `evidenceRetriever`. Null until
     * the supervisor picks the handoff with structured args; narrowed
     * against `EvidenceArgsSchema` before reaching this slot so the node
     * can trust the shape.
     */
    evidenceRetrieverArgs: lastValueChannel<EvidenceArgs | null>(() => null),
    /**
     * §C.3 retriever output: the snippets `evidenceRetriever` returns
     * for the supervisor's next iteration to reason over and for the
     * C.5 verifier to resolve `guideline` citations against. The output
     * carries a non-null `gap` when Pinecone is unreachable so the
     * supervisor sees the failure rather than an empty `snippets` array
     * (which legitimately means "indexed corpus has no match"). `null`
     * at the slot level means the retriever has not run this turn.
     */
    evidenceRetrieverOutput: lastValueChannel<EvidenceRetrieverOutput | null>(() => null),
    /**
     * §A.7 per-turn supervisor iteration counter. The supervisor node
     * increments on entry; the iteration cap (10) forces synthesize when
     * binding so the graph terminates even on degenerate sequences. Per
     * `W2_ARCHITECTURE.md` §"Iteration cap: 10" — eval-pinned, not
     * runtime-tunable in production.
     */
    supervisorIterations: lastValueChannel<number>(() => 0),
    /**
     * §A.7 per-turn decision history. Append-only across one turn —
     * cycle detection compares the latest decision against the previous
     * one to emit a `degenerate-loop` warning trace event without
     * terminating (the iteration cap is the structural backstop). The
     * synthesizer does not read this slot; it's a supervisor-internal
     * cursor plus an observability surface.
     */
    supervisorDecisionHistory: lastValueChannel<readonly SupervisorDecision[]>(() => []),
    /**
     * §A.7 cap-hit flag. Set to true when iteration 10 binds and the
     * graph forces synthesize. The synthesizer reads this for the
     * "supervisor exhausted iterations" surface; downstream eval cases
     * pin this in the cap-hit regression scenario.
     */
    capHit: lastValueChannel<boolean>(() => false),
});

export type BriefingState = typeof BriefingStateAnnotation.State;
export type BriefingStateUpdate = typeof BriefingStateAnnotation.Update;
