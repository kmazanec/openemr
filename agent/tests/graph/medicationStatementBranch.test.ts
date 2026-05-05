import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { RequestEnvelope } from '../../src/graph/types.js';
import type { AgentHttpClient } from '../../src/tools/agentHttp.js';
import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

/**
 * §4.6.6 medication-statement-detail branch — graph-level
 * integration test. Mirrors the §4.3 / §4.6.5 branch tests:
 * stub `AgentHttpClient` returns the JSON the
 * `medication_statement_provenance.php` endpoint would, then asserts
 * the synthesizer is bypassed and the verifier accepts the
 * deterministic claim.
 */

const TOKEN = 'tok';
const PATIENT_PID = 42;
const PATIENT_RECORD_ID = '42';
const LIST_ID = '95001';

const FIELD_FOR_RECORD_TYPE: Record<string, string> = {
    Patient: 'patient.name',
    Appointment: 'appointment.start',
    Condition: 'condition.code',
    MedicationRequest: 'medication.name',
    AllergyIntolerance: 'allergy.substance',
    Observation: 'observation.value',
    Encounter: 'encounter.date',
    Task: 'task.description',
    MedicationStatement: 'medicationStatement.medication',
    DocumentReference: 'documentReference.text',
};

const sourceRef = (recordType: string, recordId: string) => ({
    source_type: 'chart' as const,
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const buildSnapshot = (): unknown => ({
    patient: {
        pid: PATIENT_PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        source: sourceRef('Patient', PATIENT_RECORD_ID),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [
        {
            substance: 'NKDA',
            reaction: null,
            severity: null,
            source: sourceRef('AllergyIntolerance', 'a-nkda'),
        },
    ],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [
        {
            name: 'Tylenol',
            dose: '500 mg as needed',
            usageCategory: 'OTC',
            informationSource: 'Patient',
            startDate: '2024-06-01',
            stopDate: null,
            listId: 95001,
            source: sourceRef('MedicationStatement', LIST_ID),
        },
    ],
});

const buildSnapshotClient = (snapshot: unknown): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(snapshot)),
});

const followUpEnvelope = (listKey = `medicationStatement.medication:${LIST_ID}`): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PATIENT_PID, uuid: 'p-1' },
    task: 'follow_up',
    followUp: { type: 'medication_statement_detail', listId: listKey },
});

interface ProvenanceResponse {
    readonly provenance: {
        readonly listId: number;
        readonly name: string;
        readonly dose: string | null;
        readonly usageCategory: string | null;
        readonly informationSource: string | null;
        readonly adherenceAssertedAt: string | null;
        readonly startDate: string | null;
        readonly stopDate: string | null;
        readonly linkedPrescriptionId: number | null;
    };
}

const happyResponse = (overrides: Partial<ProvenanceResponse['provenance']> = {}): ProvenanceResponse => ({
    provenance: {
        listId: 95001,
        name: 'Tylenol',
        dose: '500 mg as needed',
        usageCategory: 'OTC',
        informationSource: 'Patient',
        adherenceAssertedAt: '2024-06-01',
        startDate: '2024-06-01',
        stopDate: null,
        linkedPrescriptionId: null,
        ...overrides,
    },
});

interface BranchCaseInput {
    readonly httpResponse?: ProvenanceResponse;
    readonly httpThrow?: Error;
    readonly envelope?: RequestEnvelope;
}

const buildGraph = (input: BranchCaseInput) => {
    const snapshot = buildSnapshot();
    const get = vi.fn((): Promise<unknown> => {
        if (input.httpThrow !== undefined) return Promise.reject(input.httpThrow);
        if (input.httpResponse !== undefined) return Promise.resolve(input.httpResponse);
        return Promise.reject(new Error('test misconfigured: no httpResponse and no httpThrow'));
    });
    const client: AgentHttpClient = { get };
    const synth = vi.fn() as unknown as Synthesizer;

    const graph = createBriefingGraph({
        retrieve: {
            client: buildSnapshotClient(snapshot),
            token: TOKEN,
            siteId: 'default',
        },
        synthesize: { synthesizer: synth },
        verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        medicationStatementDetail: {
            client,
            token: TOKEN,
            siteId: 'default',
            openEmrBaseUrl: 'http://openemr',
        },
    });
    return { graph, get, synth };
};

describe('§4.6.6 medicationStatementBranch', () => {
    it('renders the dose + usage category + information source, synthesizer NOT called', async () => {
        const { graph, synth } = buildGraph({ httpResponse: happyResponse() });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(synth).not.toHaveBeenCalled();
        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.accepted[0]?.category).toBe('medication_statement');
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toContain('Tylenol');
        expect(seg?.text).toContain('Patient');
        expect(seg?.text).toContain('OTC');
        expect(seg?.redacted).toBe(false);
    });

    it('mentions the linked prescription when the row is linked to a clinic Rx', async () => {
        const { graph } = buildGraph({
            httpResponse: happyResponse({ linkedPrescriptionId: 7001 }),
        });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.verified?.passed).toBe(true);
        expect(out.formatted?.segments[0]?.text).toContain('linked to clinic prescription 7001');
    });

    it('renders a "no record found" connector segment on 404', async () => {
        const { graph } = buildGraph({ httpThrow: new AgentHttpError(404, '') });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.formatted?.segments).toHaveLength(1);
        expect(out.formatted?.segments[0]?.text).toContain('No medication statement record found');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
        expect(out.verified?.accepted).toHaveLength(0);
    });

    it('renders a "not available" connector segment when the detail endpoint fails open', async () => {
        const { graph } = buildGraph({ httpThrow: new AgentNetworkError('boom') });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.formatted?.segments[0]?.text).toContain('not available');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
    });

    it('rejects a malformed listId without invoking the HTTP client', async () => {
        const { graph, get } = buildGraph({ httpResponse: happyResponse() });

        const out = await graph.invoke({
            envelope: followUpEnvelope('not-a-key'),
        });

        expect(get).not.toHaveBeenCalled();
        expect(out.formatted?.segments[0]?.text).toContain('not in a recognizable format');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
    });
});
