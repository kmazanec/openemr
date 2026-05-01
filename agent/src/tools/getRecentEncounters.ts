import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { Encounter } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import { decodeEncountersResponse } from './narrowResponseDecoders.js';

/**
 * Recent encounters for one patient.
 *
 * Conversational-path tool: maps 1:1 to OpenEMR's
 * `public/snapshot/encounters.php`, which runs only the
 * EncounterAdapter and writes an `encounters` audit row. Fail-open
 * with a gap on transient endpoint failures.
 */

const ENCOUNTERS_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/encounters.php';

export interface GetRecentEncountersInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type RecentEncountersResult = FailOpenResult<{ readonly encounters: readonly Encounter[] }>;

const buildUrl = (input: GetRecentEncountersInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${ENCOUNTERS_PATH}?${params.toString()}`;
};

const impl = async (input: GetRecentEncountersInput): Promise<RecentEncountersResult> => {
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
            return { kind: 'ok', encounters: decodeEncountersResponse(raw) };
        } catch (err) {
            if (isFailOpenError(err)) {
                return toGap(err, 'Recent encounters');
            }
            throw err;
        }
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getRecentEncounters', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getRecentEncounters' });
    }
};

export const getRecentEncounters = traceable(impl, {
    name: 'getRecentEncounters',
    run_type: 'tool',
});

export const getRecentEncountersTool = {
    name: 'getRecentEncounters',
    description:
        'Fetch encounter records (visits) for the patient in the last 12 months: encounter date, type, and reason. Use this for questions about recent visits or visit history. May fail-open with a gap if the encounters endpoint is briefly unavailable.',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch encounters for.',
            },
        },
        required: ['patientPid'],
    },
} as const;
