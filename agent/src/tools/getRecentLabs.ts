import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { LabObservation } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import { decodeLabsResponse } from './narrowResponseDecoders.js';

/**
 * Recent labs for one patient.
 *
 * Conversational-path tool: maps 1:1 to OpenEMR's
 * `public/snapshot/labs.php`, which runs only the
 * ObservationAdapter and writes a `labs` audit row. The model picks
 * this on follow-ups like "what was her last A1c?".
 *
 * Fail-open: a transient labs-endpoint failure renders as a gap
 * rather than crashing the whole conversation.
 */

const LABS_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/labs.php';

export interface GetRecentLabsInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type RecentLabsResult = FailOpenResult<{ readonly labs: readonly LabObservation[] }>;

const buildUrl = (input: GetRecentLabsInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${LABS_PATH}?${params.toString()}`;
};

const impl = async (input: GetRecentLabsInput): Promise<RecentLabsResult> => {
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
            return { kind: 'ok', labs: decodeLabsResponse(raw) };
        } catch (err) {
            if (isFailOpenError(err)) {
                return toGap(err, 'Recent labs');
            }
            throw err;
        }
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getRecentLabs', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getRecentLabs' });
    }
};

export const getRecentLabs = traceable(impl, { name: 'getRecentLabs', run_type: 'tool' });

export const getRecentLabsTool = {
    name: 'getRecentLabs',
    description:
        'Fetch labs observed for the patient in the last 12 months: analyte name, value (preserved as a string so qualifiers like ">500" or "positive" survive), unit, reference range, abnormal flag, and observed_at. Use this for questions about lab results, trends, or specific test values. May fail-open with a gap if the labs endpoint is briefly unavailable.',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch labs for.',
            },
        },
        required: ['patientPid'],
    },
} as const;
