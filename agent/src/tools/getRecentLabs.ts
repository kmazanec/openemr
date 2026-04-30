import { traceable } from 'langsmith/traceable';

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
    readonly pid: number;
}

export type RecentLabsResult = FailOpenResult<{ readonly labs: readonly LabObservation[] }>;

const impl = async (input: GetRecentLabsInput): Promise<RecentLabsResult> => {
    try {
        const raw = await input.client.fetchSnapshot({
            pid: input.pid,
            categories: ['lab'],
            token: input.token,
        });
        return { kind: 'ok', labs: decodeChartSnapshot(raw).labs };
    } catch (err) {
        if (isFailOpenError(err)) {
            return toGap(err, 'Recent labs');
        }
        throw err;
    }
};

export const getRecentLabs = traceable(impl, { name: 'getRecentLabs', run_type: 'tool' });
