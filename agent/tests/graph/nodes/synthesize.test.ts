import { describe, expect, it, vi } from 'vitest';

import { createSynthesize, type Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type {
    BriefingSnapshot,
    ClaimLedger,
    RequestEnvelope,
} from '../../../src/graph/types.js';

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        source: sourceRef('Patient', '42'),
    },
    appointment: null,
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: sourceRef('Condition', 'c-1'),
        },
    ],
    medications: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            source: sourceRef('MedicationRequest', 'rx-1'),
        },
    ],
    allergies: [],
    labs: [],
    encounters: [],
};

const ledger: ClaimLedger = {
    claims: [
        {
            id: 'c-1',
            text: 'Patient has type 2 diabetes (E11.9)',
            category: 'diagnosis',
            sourceReferences: [sourceRef('Condition', 'c-1')],
            safetyCritical: false,
        },
    ],
};

describe('createSynthesize', () => {
    it('calls the synthesizer with the assembled prompt and returns its draft + ledger', async () => {
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: 'Mrs. Patel, here for diabetes follow-up.',
                ledger,
            }),
        );
        const node = createSynthesize({ synthesizer: synth });

        const out = await node({
            envelope,
            snapshot,
            draft: null, claimLedger: null, verified: null, formatted: null, persisted: null,
        });

        expect(synth).toHaveBeenCalledTimes(1);
        expect(out.draft).toBe('Mrs. Patel, here for diabetes follow-up.');
        expect(out.claimLedger).toEqual(ledger);
    });

    it('throws when called before Retrieve populated the snapshot', async () => {
        const synth: Synthesizer = vi.fn(() => Promise.reject(new Error('should not be called')));
        const node = createSynthesize({ synthesizer: synth });
        await expect(
            node({
                envelope,
                snapshot: null,
                draft: null, claimLedger: null, verified: null, formatted: null, persisted: null,
            }),
        ).rejects.toThrow(/snapshot/i);
    });
});
