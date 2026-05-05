import { Annotation } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

import type {
    AssistantMessage,
    BriefingSnapshot,
    ClaimLedger,
    DraftBriefing,
    PersistedRecord,
    PriorTurnContext,
    RequestEnvelope,
    RetrieveChartArgs,
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
});

export type BriefingState = typeof BriefingStateAnnotation.State;
export type BriefingStateUpdate = typeof BriefingStateAnnotation.Update;
