import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import { decodeChartSnapshot } from '../snapshot/decode.js';
import type { ChartSnapshot } from '../snapshot/types.js';

import type { SnapshotClient } from './snapshotClient.js';

/**
 * Briefing-path retrieval tool. Fetches the entire chart snapshot in
 * one HTTP call and decodes it once — replacing the four-tool fan-out
 * that previously hit `snapshot.php` four times for the same payload.
 *
 * The narrow per-category tools (`getPrescriptions`,
 * `getRecentLabs`, etc.) stay around for the conversational path,
 * where the model
 * picks which tool to call against its own dedicated endpoint. They
 * are no longer used by the briefing graph.
 *
 * Architecturally fail-closed: the briefing cannot start without
 * patient context, so a snapshot failure must propagate. The
 * fail-open semantics for labs/encounters now express as field-level
 * checks in `retrieve.ts` (well-formed empty array vs missing data),
 * not at the tool boundary.
 */

const ALL_CATEGORIES = [
    'diagnosis',
    'prescription',
    'allergy',
    'lab',
    'encounter',
    'reminder',
    'medication_statement',
] as const;

export interface LoadChartSnapshotInput {
    readonly client: SnapshotClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    /** §6.1: optional counters sink. Production wires this from
     * `briefingRunner`; tests omit it to fall back to a noop. */
    readonly counters?: Counters;
}

const impl = async (input: LoadChartSnapshotInput): Promise<ChartSnapshot> => {
    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.fetchSnapshot({
            pid: input.pid,
            categories: ALL_CATEGORIES,
            token: input.token,
            siteId: input.siteId,
        });
        return decodeChartSnapshot(raw);
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'loadChartSnapshot', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'loadChartSnapshot' });
    }
};

export const loadChartSnapshot = traceable(impl, {
    name: 'loadChartSnapshot',
    run_type: 'tool',
});
