import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { VitalSign } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import { decodeVitalsResponse } from './narrowResponseDecoders.js';

/**
 * Recent vital-sign readings for one patient.
 *
 * Conversational-path tool: maps 1:1 to OpenEMR's
 * `public/snapshot/vitals.php`, which runs only the VitalsAdapter
 * and writes a `vitals` audit row. Picked by the model on
 * follow-ups like "what was her last BP?" or "what's his weight
 * been?".
 *
 * Fail-open: a transient vitals-endpoint failure renders as a gap
 * rather than crashing the conversation.
 */

const VITALS_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/vitals.php';

export interface GetVitalsInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type RecentVitalsResult = FailOpenResult<{ readonly vitals: readonly VitalSign[] }>;

const buildUrl = (input: GetVitalsInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${VITALS_PATH}?${params.toString()}`;
};

const impl = async (input: GetVitalsInput): Promise<RecentVitalsResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        try {
            const raw = await input.client.get({ url: buildUrl(input), token: input.token });
            return { kind: 'ok', vitals: decodeVitalsResponse(raw) };
        } catch (err) {
            if (isFailOpenError(err)) {
                return toGap(err, 'Recent vitals');
            }
            throw err;
        }
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getVitals', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getVitals' });
    }
};

export const getVitals = traceable(impl, { name: 'getVitals', run_type: 'tool' });

export const getVitalsTool = {
    name: 'getVitals',
    description:
        "Fetch the patient's vital-sign readings (BP, pulse, respiration, temperature, weight, height, BMI, oxygen saturation) from the last 12 months. Each row is a single visit's snapshot; numeric fields are preserved as strings to keep source-side rounding intact, and a field is null when not measured at that visit. Use this for questions about vitals at the last visit or the most recent BP/weight. May fail-open with a gap if the vitals endpoint is briefly unavailable.",
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch vitals for.',
            },
        },
        required: ['patientPid'],
    },
} as const;
