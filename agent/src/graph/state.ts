import { Annotation } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

import type {
    BriefingSnapshot,
    ClaimLedger,
    FormattedBriefing,
    PersistedRecord,
    RequestEnvelope,
    VerifiedLedger,
} from './types.js';

/**
 * Plan §3.2 state shape: `{envelope, snapshot, draft, claimLedger,
 * verified, formatted, persisted}`. Each downstream node populates its
 * own slot — the `draft` (free-text Sonnet output) is kept alongside
 * the structured `claimLedger` so `Verify` (Phase 3.3) can compare the
 * two. Defaults are null so a partially-run graph state is recognizable.
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
    snapshot: lastValueChannel<BriefingSnapshot | null>(() => null),
    draft: lastValueChannel<string | null>(() => null),
    claimLedger: lastValueChannel<ClaimLedger | null>(() => null),
    verified: lastValueChannel<VerifiedLedger | null>(() => null),
    formatted: lastValueChannel<FormattedBriefing | null>(() => null),
    persisted: lastValueChannel<PersistedRecord | null>(() => null),
});

export type BriefingState = typeof BriefingStateAnnotation.State;
export type BriefingStateUpdate = typeof BriefingStateAnnotation.Update;
