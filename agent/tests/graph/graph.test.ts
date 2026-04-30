import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { ClaimLedger, RequestEnvelope } from '../../src/graph/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

const TOKEN = 'tok';
const PID = 42;

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'default_briefing',
};

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const happyPathSnapshot = {
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
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
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'Moderate',
            source: sourceRef('AllergyIntolerance', 'a-1'),
        },
    ],
    labs: [],
    encounters: [],
};

interface MockClient {
    readonly client: SnapshotClient;
    readonly fetch: ReturnType<typeof vi.fn>;
}

const buildClient = (): MockClient => {
    const fetch = vi.fn(() => Promise.resolve(happyPathSnapshot));
    return { client: { fetchSnapshot: fetch }, fetch };
};

const cannedLedger: ClaimLedger = {
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

const buildSynth = (): Synthesizer =>
    vi.fn(() => Promise.resolve({ draft: 'Synthesized briefing.', ledger: cannedLedger }));

describe('createBriefingGraph end-to-end (UC1 path)', () => {
    it('runs LoadState → PlanContext → Retrieve → Synthesize → Verify → Format → Persist', async () => {
        const { client } = buildClient();
        const synth = buildSynth();
        const graph = createBriefingGraph({
            retrieve: { client, token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope });

        expect(out.snapshot).toBeDefined();
        expect(out.snapshot?.patient.pid).toBe(PID);
        expect(out.draft).toBe('Synthesized briefing.');
        expect(out.claimLedger).toEqual(cannedLedger);
        expect(out.verified?.passed).toBe(true);
        expect(out.formatted).toBeDefined();
        expect(out.formatted?.demographics.text).toContain('Patel, Maya');
        expect(out.persisted?.conversationId).toBe('c-1');
    });

    it('drives Retrieve once per invoke', async () => {
        const { client, fetch } = buildClient();
        const synth = buildSynth();
        const graph = createBriefingGraph({
            retrieve: { client, token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        await graph.invoke({ envelope });

        // Four §3.1 tools each fetch the snapshot once → 4 calls total.
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(synth).toHaveBeenCalledTimes(1);
    });
});
