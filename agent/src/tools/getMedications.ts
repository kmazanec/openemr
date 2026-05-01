import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import { decodeChartSnapshot } from '../snapshot/decode.js';
import type { Medication } from '../snapshot/types.js';
import type { SnapshotClient } from './snapshotClient.js';

/**
 * Active medications, doses, frequencies, prescriber, start/stop dates.
 * Architecture §"Tool And Adapter Layer" pins this as **fail-closed**:
 * the medication summary is the most safety-relevant section in UC1, so
 * an unreachable or malformed endpoint surfaces as a thrown error rather
 * than a silently-empty list.
 */

export interface GetMedicationsInput {
    readonly client: SnapshotClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    /** §6.1: optional counters sink. Production wires this from
     * `briefingRunner`; tests omit it to fall back to a noop. */
    readonly counters?: Counters;
}

const impl = async (input: GetMedicationsInput): Promise<readonly Medication[]> => {
    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.fetchSnapshot({
            pid: input.pid,
            categories: ['medication'],
            token: input.token,
            siteId: input.siteId,
        });
        return decodeChartSnapshot(raw).medications;
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getMedications', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getMedications' });
    }
};

export const getMedications = traceable(impl, { name: 'getMedications', run_type: 'tool' });
