import { traceable } from 'langsmith/traceable';

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
    readonly pid: number;
}

export interface PatientContext {
    readonly patient: Demographics;
    readonly diagnoses: readonly Diagnosis[];
    readonly allergies: readonly Allergy[];
}

const impl = async (input: GetPatientContextInput): Promise<PatientContext> => {
    const raw = await input.client.fetchSnapshot({
        pid: input.pid,
        categories: ['diagnosis', 'allergy'],
        token: input.token,
    });
    const snapshot = decodeChartSnapshot(raw);
    return {
        patient: snapshot.patient,
        diagnoses: snapshot.diagnoses,
        allergies: snapshot.allergies,
    };
};

export const getPatientContext = traceable(impl, { name: 'getPatientContext', run_type: 'tool' });
