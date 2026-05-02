import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { LabObservation } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import { decodeLabsResponse } from './narrowResponseDecoders.js';

/**
 * Lab history for one analyte over a configurable lookback window.
 *
 * UC2 (lab/vitals trend) tool. Maps 1:1 to OpenEMR's
 * `public/snapshot/lab-history.php`, which runs only the
 * ObservationAdapter's `fetchHistoryByAnalyte` path and writes a
 * `lab-history` audit row. The synthesizer picks this when the
 * envelope carries a typed `lab_trend` follow-up — the analyte
 * comes from the suggestion's params, not from natural-language
 * parsing.
 *
 * Fail-open: a transient endpoint failure renders as a gap rather
 * than crashing the conversation. The graph file the gap into
 * `snapshot.labHistory` so the UI can surface "history unavailable"
 * instead of silently rendering an empty trend.
 */

const LAB_HISTORY_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/lab-history.php';

const MAX_LOOKBACK_DAYS = 3650;

export interface GetLabHistoryInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly analyte: string;
    readonly lookbackDays: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type LabHistoryResult = FailOpenResult<{ readonly labs: readonly LabObservation[] }>;

const buildUrl = (input: GetLabHistoryInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        analyte: input.analyte,
        lookback_days: String(input.lookbackDays),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${LAB_HISTORY_PATH}?${params.toString()}`;
};

const impl = async (input: GetLabHistoryInput): Promise<LabHistoryResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }
    if (input.analyte.length === 0) {
        throw new Error('analyte is required');
    }
    if (
        !Number.isInteger(input.lookbackDays)
        || input.lookbackDays <= 0
        || input.lookbackDays > MAX_LOOKBACK_DAYS
    ) {
        throw new Error(`lookbackDays must be a positive integer ≤ ${String(MAX_LOOKBACK_DAYS)}`);
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        try {
            const raw = await input.client.get({ url: buildUrl(input), token: input.token });
            return { kind: 'ok', labs: decodeLabsResponse(raw) };
        } catch (err) {
            if (isFailOpenError(err)) {
                return toGap(err, 'Lab history');
            }
            throw err;
        }
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getLabHistory', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getLabHistory' });
    }
};

export const getLabHistory = traceable(impl, { name: 'getLabHistory', run_type: 'tool' });

export const getLabHistoryTool = {
    name: 'getLabHistory',
    description:
        'Fetch the patient\'s history for a single lab analyte over a configurable lookback window. Each entry carries analyte, value (preserved as a string), unit, reference range, abnormal flag, and observed_at, ordered oldest-first so a trend reads naturally. Use this to answer "is X trending up/down/stable?". May fail-open with a gap if the lab-history endpoint is briefly unavailable.',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch lab history for.',
            },
            analyte: {
                type: 'string' as const,
                description: 'Canonical analyte name (e.g. "Hemoglobin A1c"). Matched case-insensitively as a substring on the stored analyte text.',
            },
            lookbackDays: {
                type: 'integer' as const,
                description: 'How many days of history to include. Trend questions typically use 730 (two years).',
            },
        },
        required: ['patientPid', 'analyte', 'lookbackDays'],
    },
} as const;
