import { traceable } from 'langsmith/traceable';

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
}

const impl = async (input: GetMedicationsInput): Promise<readonly Medication[]> => {
    const raw = await input.client.fetchSnapshot({
        pid: input.pid,
        categories: ['medication'],
        token: input.token,
        siteId: input.siteId,
    });
    return decodeChartSnapshot(raw).medications;
};

export const getMedications = traceable(impl, { name: 'getMedications', run_type: 'tool' });
