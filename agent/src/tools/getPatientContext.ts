import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import { decodeChartSnapshot } from '../snapshot/decode.js';
import type { Allergy, Demographics, Diagnosis } from '../snapshot/types.js';
import type { SnapshotClient } from './snapshotClient.js';

/**
 * Identity + active diagnoses + allergies for the briefing's opening
 * sections. Architecture §"Tool And Adapter Layer" pins this as
 * **fail-closed**: an HTTP/network error or a missing `allergies` field
 * surfaces as a thrown error so the Verify gate (Phase 3.3) can hard-stop
 * the medication summary.
 *
 * An empty `allergies` array is *not* a failure — a patient may have NKDA
 * documented. Only a missing-from-the-response shape is a failure, and
 * the decoder rejects that.
 */

export interface GetPatientContextInput {
    readonly client: SnapshotClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    /** §6.1: optional counters sink. */
    readonly counters?: Counters;
}

export interface PatientContext {
    readonly patient: Demographics;
    readonly diagnoses: readonly Diagnosis[];
    readonly allergies: readonly Allergy[];
}

const impl = async (input: GetPatientContextInput): Promise<PatientContext> => {
    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.fetchSnapshot({
            pid: input.pid,
            categories: ['diagnosis', 'allergy'],
            token: input.token,
            siteId: input.siteId,
        });
        const snapshot = decodeChartSnapshot(raw);
        return {
            patient: snapshot.patient,
            diagnoses: snapshot.diagnoses,
            allergies: snapshot.allergies,
        };
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getPatientContext', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getPatientContext' });
    }
};

export const getPatientContext = traceable(impl, { name: 'getPatientContext', run_type: 'tool' });
