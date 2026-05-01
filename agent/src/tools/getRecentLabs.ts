import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import { decodeChartSnapshot } from '../snapshot/decode.js';
import type { LabObservation } from '../snapshot/types.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import type { SnapshotClient } from './snapshotClient.js';

/**
 * Recent labs for the briefing. Architecture §"Tool And Adapter Layer"
 * pins this as **fail-open with explicit gap** — labs are informational
 * and should not block the briefing if the data layer hiccups.
 */

export interface GetRecentLabsInput {
    readonly client: SnapshotClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    /** §6.1: optional counters sink. */
    readonly counters?: Counters;
}

export type RecentLabsResult = FailOpenResult<{ readonly labs: readonly LabObservation[] }>;

const impl = async (input: GetRecentLabsInput): Promise<RecentLabsResult> => {
    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        try {
            const raw = await input.client.fetchSnapshot({
                pid: input.pid,
                categories: ['lab'],
                token: input.token,
                siteId: input.siteId,
            });
            return { kind: 'ok', labs: decodeChartSnapshot(raw).labs };
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
