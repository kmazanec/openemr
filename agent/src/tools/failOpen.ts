import { AgentHttpError, AgentNetworkError } from './agentHttp.js';
import { SnapshotHttpError, SnapshotNetworkError } from './snapshotClient.js';

/**
 * Shared result type for the fail-open tools (`getRecentLabs`,
 * `getRecentEncounters`). Architecture §"Tool And Adapter Layer"
 * pins these as **fail-open with explicit gap**: a transient
 * data-layer failure should not block the briefing or follow-up —
 * render the gap explicitly so the verifier can mark the section as
 * unavailable rather than silently present a possibly-incomplete
 * answer.
 *
 * Auth failures (401/403) are deliberately *not* converted to gaps
 * here — they signal a misconfigured trust boundary, which the agent
 * should surface as a hard error so we hear about it immediately.
 *
 * The narrow conversational-path tools throw {@link AgentHttpError}
 * / {@link AgentNetworkError}; the briefing-path snapshot client
 * still throws the older {@link SnapshotHttpError} /
 * {@link SnapshotNetworkError}. This module accepts both so a
 * fail-open tool works whichever client is wired in.
 */
export type FailOpenGap =
    | { readonly kind: 'gap'; readonly reason: 'endpoint-unavailable'; readonly message: string }
    | { readonly kind: 'gap'; readonly reason: 'endpoint-unreachable'; readonly message: string };

export type FailOpenResult<T> = { readonly kind: 'ok' } & T | FailOpenGap;

const AUTH_STATUSES = new Set([401, 403]);

type FailOpenError = AgentHttpError | AgentNetworkError | SnapshotHttpError | SnapshotNetworkError;

export const isFailOpenError = (err: unknown): err is FailOpenError => {
    if (err instanceof AgentNetworkError || err instanceof SnapshotNetworkError) {
        return true;
    }
    if (
        (err instanceof AgentHttpError || err instanceof SnapshotHttpError)
        && !AUTH_STATUSES.has(err.status)
    ) {
        return true;
    }
    return false;
};

export const toGap = (err: FailOpenError, label: string): FailOpenGap => {
    if (err instanceof AgentNetworkError || err instanceof SnapshotNetworkError) {
        return {
            kind: 'gap',
            reason: 'endpoint-unreachable',
            message: `${label} are not available right now (endpoint unreachable).`,
        };
    }
    return {
        kind: 'gap',
        reason: 'endpoint-unavailable',
        message: `${label} are not available right now (status ${String(err.status)}).`,
    };
};
