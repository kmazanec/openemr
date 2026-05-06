import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';

import { AgentHttpError, type AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import {
    decodeReminderDetailResponse,
    type ReminderDetail,
} from './narrowResponseDecoders.js';

/**
 * Detail for a single clinical reminder. The deterministic
 * reminder-detail branch that used to consume this is gone — the tool
 * stays on disk as a supervisor-pickable handoff candidate for future
 * "when is X due?" routing.
 *
 * **Behavioral contract (pinned by tests, not just docs):**
 * - 404 from the endpoint is a *deterministic* "no record found" —
 *   the tool returns `{ kind: 'ok', detail: null }` so the branch
 *   can render a connector segment instead of a hallucinated answer.
 * - 5xx / network failures fail open with a typed gap.
 * - 401/403 throw — that signals a misconfigured trust boundary,
 *   not a data gap.
 */

const REMINDER_DETAIL_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/reminder_detail.php';

export interface GetReminderDetailInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly reminderId: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type ReminderDetailResult = FailOpenResult<{
    readonly detail: ReminderDetail | null;
}>;

const buildUrl = (input: GetReminderDetailInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        reminderId: String(input.reminderId),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${REMINDER_DETAIL_PATH}?${params.toString()}`;
};

const impl = async (
    input: GetReminderDetailInput,
): Promise<ReminderDetailResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (!Number.isInteger(input.reminderId) || input.reminderId <= 0) {
        throw new Error('reminderId must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.get({ url: buildUrl(input), token: input.token });
        const detail = decodeReminderDetailResponse(raw);
        return { kind: 'ok', detail };
    } catch (err) {
        // 404 is *not* a fail-open gap — see contract above.
        if (err instanceof AgentHttpError && err.status === 404) {
            return { kind: 'ok', detail: null };
        }
        if (isFailOpenError(err)) {
            return toGap(err, 'Reminder detail');
        }
        throw err;
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getReminderDetail', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getReminderDetail' });
    }
};

export const getReminderDetail = traceable(impl, {
    name: 'getReminderDetail',
    run_type: 'tool',
});

/**
 * Anthropic tool-use registration metadata. The §4.6.5 graph branch
 * calls this tool directly (deterministic path); the registration is
 * here for symmetry with the other narrow tools.
 */
export const getReminderDetailTool = {
    name: 'getReminderDetail',
    description:
        "Fetch detail for a single clinical reminder: rule description, item/category titles, due status, creation date. Use when the question is about WHY a reminder is due or WHAT the rule is. Reminder ids come from the snapshot's `reminders[].reminderId` (or the suggested-follow-up's typed `reminderId`).",
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid).',
            },
            reminderId: {
                type: 'integer' as const,
                description: "Reminder record id (the snapshot's reminder source.recordId).",
            },
        },
        required: ['patientPid', 'reminderId'],
    },
} as const;
