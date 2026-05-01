import {
    APIConnectionError,
    AuthenticationError,
    BadRequestError,
    InternalServerError,
    PermissionDeniedError,
    RateLimitError,
} from '@anthropic-ai/sdk';

import { AgentHttpError, AgentNetworkError } from '../tools/agentHttp.js';
import { SnapshotHttpError, SnapshotNetworkError } from '../tools/snapshotClient.js';

/**
 * Maps an internal failure inside the briefing runner to the typed error
 * code the SSE protocol exposes to the browser. The codes are deliberately
 * coarse — the UI maps them to a generic message ("AI service unavailable",
 * "Patient chart could not be loaded") so end users never see provider
 * names, billing details, or stack frames. CLAUDE.md is explicit about
 * never leaking exception messages to the user.
 *
 * Adding a new code:
 *   1. Add it to `BriefingErrorCode`.
 *   2. Add a branch here that maps the underlying error class.
 *   3. Add the matching user-facing message in `panel.js`'s
 *      `BRIEFING_ERROR_MESSAGES` map.
 */
export type BriefingErrorCode =
    | 'model_unavailable'
    | 'model_rate_limited'
    | 'chart_unavailable'
    | 'briefing_failed';

export const classifyBriefingError = (err: unknown): BriefingErrorCode => {
    // Anthropic 429 → its own bucket so the UI can suggest retry.
    if (err instanceof RateLimitError) return 'model_rate_limited';

    // Anthropic 4xx (bad-request, auth, permission, billing — billing arrives
    // as a 400 BadRequestError) and 5xx are all the same to the user: the
    // AI service is unreachable right now.
    if (
        err instanceof BadRequestError ||
        err instanceof AuthenticationError ||
        err instanceof PermissionDeniedError ||
        err instanceof InternalServerError ||
        err instanceof APIConnectionError
    ) {
        return 'model_unavailable';
    }

    // Snapshot fetch failed — the briefing can't even start because we
    // couldn't read the patient chart. Distinct from a model failure
    // because the user action ("try again") and the operator action
    // (check OpenEMR vs check the LLM provider) differ. Both the
    // legacy snapshot client (briefing path) and the narrow per-tool
    // client (conversational path) surface the same condition under
    // their own error types — both are classified the same way.
    if (
        err instanceof SnapshotHttpError
        || err instanceof SnapshotNetworkError
        || err instanceof AgentHttpError
        || err instanceof AgentNetworkError
    ) {
        return 'chart_unavailable';
    }

    return 'briefing_failed';
};
