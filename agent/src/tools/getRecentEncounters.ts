import { traceable } from 'langsmith/traceable';

import { decodeChartSnapshot } from '../snapshot/decode.js';
import type { Encounter } from '../snapshot/types.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import type { SnapshotClient } from './snapshotClient.js';

/**
 * Recent encounters for the briefing. Architecture §"Tool And Adapter
 * Layer" pins this as **fail-open with explicit gap** — encounter
 * history is informational and should not block the briefing if the
 * data layer hiccups.
 */

export interface GetRecentEncountersInput {
    readonly client: SnapshotClient;
    readonly token: string;
    readonly pid: number;
}

export type RecentEncountersResult = FailOpenResult<{ readonly encounters: readonly Encounter[] }>;

const impl = async (input: GetRecentEncountersInput): Promise<RecentEncountersResult> => {
    try {
        const raw = await input.client.fetchSnapshot({
            pid: input.pid,
            categories: ['encounter'],
            token: input.token,
        });
        return { kind: 'ok', encounters: decodeChartSnapshot(raw).encounters };
    } catch (err) {
        if (isFailOpenError(err)) {
            return toGap(err, 'Recent encounters');
        }
        throw err;
    }
};

export const getRecentEncounters = traceable(impl, {
    name: 'getRecentEncounters',
    run_type: 'tool',
});
