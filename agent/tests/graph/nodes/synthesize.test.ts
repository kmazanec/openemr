import { describe, expect, it, vi } from 'vitest';

import { createSynthesize, type Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type {
    BriefingSnapshot,
    ClaimLedger,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';

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
    prescriptions: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            indication: null,
            prescriptionId: 'rx-1',
            source: sourceRef('MedicationRequest', 'rx-1'),
        },
    ],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
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

const draft = {
    segments: [
        { text: 'Mrs. Patel, here for diabetes follow-up.', claimIds: ['c-1'] },
    ],
};

describe('createSynthesize', () => {
    it('calls the synthesizer with the assembled prompt and returns its draft + ledger', async () => {
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({ draft, ledger }),
        );
        const node = createSynthesize({ synthesizer: synth });

        const out = await node({
            envelope,
            snapshot,
            draft: null, claimLedger: null, verified: null, formatted: null, persisted: null,
        });

        expect(synth).toHaveBeenCalledTimes(1);
        expect(out.draft).toEqual(draft);
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

    it('records token usage and dollar cost on the counters sink when usage is reported', async () => {
        const counters = createInMemoryCounters();
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft,
                ledger,
                usage: {
                    model: 'claude-sonnet-4-6',
                    inputTokens: 2_000_000,
                    outputTokens: 1_000_000,
                },
            }),
        );
        const node = createSynthesize({ synthesizer: synth, counters });

        await node({
            envelope,
            snapshot,
            draft: null, claimLedger: null, verified: null, formatted: null, persisted: null,
        });

        const snap = counters.snapshot();
        const usage = snap.modelUsage['claude-sonnet-4-6']!;
        expect(usage.inputTokens).toBe(2_000_000);
        expect(usage.outputTokens).toBe(1_000_000);
        // 2M @ $3/M input + 1M @ $15/M output = $6 + $15 = $21
        expect(usage.costUsd).toBeCloseTo(21, 4);
    });

    it('skips the counter call when usage is not reported (deterministic test synthesizers)', async () => {
        const counters = createInMemoryCounters();
        const synth: Synthesizer = vi.fn(() => Promise.resolve({ draft, ledger }));
        const node = createSynthesize({ synthesizer: synth, counters });

        await node({
            envelope,
            snapshot,
            draft: null, claimLedger: null, verified: null, formatted: null, persisted: null,
        });

        const snap = counters.snapshot();
        expect(Object.keys(snap.modelUsage)).toHaveLength(0);
    });
});
