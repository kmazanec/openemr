import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { VitalSign } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import { decodeVitalsResponse } from './narrowResponseDecoders.js';

/**
 * Vitals history for one vital type (BP, weight, ...) over a
 * configurable lookback window. Sibling of `getLabHistory`.
 *
 * Maps 1:1 to OpenEMR's `public/snapshot/vitals-history.php`, which
 * runs only the VitalsAdapter's `fetchHistory` path and writes a
 * `vitals-history` audit row. The vital-type token is validated
 * server-side against an allowlist; clients should pass one of the
 * canonical tokens enumerated in {@link VITAL_TYPE_TOKENS}.
 *
 * Fail-open: a transient endpoint failure renders as a gap rather
 * than crashing the conversation.
 */

const VITALS_HISTORY_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/vitals-history.php';

const MAX_LOOKBACK_DAYS = 3650;

/**
 * Allowed vital-type tokens — kept here so the tool's input schema
 * carries the closed set into the model's view of the API. The
 * server-side allowlist in `VitalsAdapter::VITAL_TYPES` is the
 * source of truth; this list must stay in sync (covered by the
 * cross-language contract test).
 */
export const VITAL_TYPE_TOKENS = [
    'systolic_bp',
    'diastolic_bp',
    'pulse',
    'respiration',
    'temperature',
    'weight',
    'height',
    'bmi',
    'oxygen_saturation',
] as const;

export type VitalTypeToken = (typeof VITAL_TYPE_TOKENS)[number];

export interface GetVitalsHistoryInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly vitalType: VitalTypeToken;
    readonly lookbackDays: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type VitalsHistoryResult = FailOpenResult<{ readonly vitals: readonly VitalSign[] }>;

const buildUrl = (input: GetVitalsHistoryInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        vital_type: input.vitalType,
        lookback_days: String(input.lookbackDays),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${VITALS_HISTORY_PATH}?${params.toString()}`;
};

const impl = async (input: GetVitalsHistoryInput): Promise<VitalsHistoryResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }
    if (!VITAL_TYPE_TOKENS.includes(input.vitalType)) {
        throw new Error(`vitalType must be one of: ${VITAL_TYPE_TOKENS.join(', ')}`);
    }
    if (
        !Number.isInteger(input.lookbackDays) ||
        input.lookbackDays <= 0 ||
        input.lookbackDays > MAX_LOOKBACK_DAYS
    ) {
        throw new Error(`lookbackDays must be a positive integer ≤ ${String(MAX_LOOKBACK_DAYS)}`);
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        try {
            const raw = await input.client.get({ url: buildUrl(input), token: input.token });
            return { kind: 'ok', vitals: decodeVitalsResponse(raw) };
        } catch (err) {
            if (isFailOpenError(err)) {
                return toGap(err, 'Vitals history');
            }
            throw err;
        }
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getVitalsHistory', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getVitalsHistory' });
    }
};

export const getVitalsHistory = traceable(impl, { name: 'getVitalsHistory', run_type: 'tool' });

export const getVitalsHistoryTool = {
    name: 'getVitalsHistory',
    description:
        "Fetch the patient's history for a single vital sign (e.g. systolic BP, weight, pulse) over a configurable lookback window. Each entry is a per-visit reading, ordered oldest-first so a trend reads naturally. Numeric values are preserved as strings; null fields are excluded server-side. Use this to answer 'is BP/weight trending up or down over the last year?'. May fail-open with a gap if the endpoint is briefly unavailable.",
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch vitals history for.',
            },
            vitalType: {
                type: 'string' as const,
                enum: [...VITAL_TYPE_TOKENS],
                description:
                    "Which vital sign to fetch history for. One of: 'systolic_bp', 'diastolic_bp', 'pulse', 'respiration', 'temperature', 'weight', 'height', 'bmi', 'oxygen_saturation'.",
            },
            lookbackDays: {
                type: 'integer' as const,
                description:
                    'How many days of history to include. BP/weight trend questions typically use 365–730.',
            },
        },
        required: ['patientPid', 'vitalType', 'lookbackDays'],
    },
} as const;
