import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { RequestEnvelope } from '../../src/graph/types.js';
import type { AgentHttpClient } from '../../src/tools/agentHttp.js';
import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

/**
 * §4.3 UC3 medication-change branch — graph-level integration test.
 *
 * The branch fires only when the typed `followUp.type` is
 * `medication_change` *and* `medChange` deps are wired. Each case
 * here builds a graph with a stub `AgentHttpClient` that returns the
 * appropriate JSON for the medication_provenance endpoint, then runs
 * the graph end-to-end to confirm:
 *  - the synthesizer mock is *not* called (the branch bypasses it)
 *  - the verifier accepts/rejects per the deterministic rule
 *  - the formatted segment carries only documented fields
 */

const TOKEN = 'tok';
const PATIENT_PID = 42;
const PATIENT_RECORD_ID = '42';
const PRESCRIPTION_ID = '7001';

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

interface SnapshotMedOverrides {
    readonly prescriber?: string | null;
    readonly indication?: string | null;
}

// Wire shape: matches the JSON the OpenEMR snapshot endpoint emits (so
// `decodeChartSnapshot` walks it normally). Cast through `unknown` so
// the test isn't forced to pre-decode every fixture.
const buildSnapshot = (med: SnapshotMedOverrides = {}): unknown => {
    // `??` would coerce an explicit null override back to the default;
    // `in` lets a caller assert "field is null" without falling through.
    const prescriber = 'prescriber' in med ? med.prescriber : 'Patel, Maya';
    const indication = 'indication' in med ? med.indication : 'new-onset hypertension';
    return {
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
        medications: [
            {
                name: 'Lisinopril',
                dose: '10 mg',
                route: 'PO',
                frequency: 'daily',
                startDate: '2026-03-20',
                stopDate: null,
                prescriber,
                indication,
                prescriptionId: 7001,
                source: sourceRef('MedicationRequest', PRESCRIPTION_ID),
            },
        ],
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
    };
};

const buildClient = (snapshot: unknown): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(snapshot)),
});

const followUpEnvelope = (): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PATIENT_PID, uuid: 'p-1' },
    task: 'follow_up',
    followUp: { type: 'medication_change', medicationId: `MedicationRequest:${PRESCRIPTION_ID}` },
});

interface ProvenanceResponse {
    readonly provenance: {
        readonly prescriptionId: number;
        readonly drugName: string;
        readonly prescriber: string | null;
        readonly prescribingDate: string | null;
        readonly indication: string | null;
        readonly doseAdjustments: readonly { readonly dose: string | null; readonly date: string | null }[];
    };
}

interface BranchCaseInput {
    readonly snapshot?: unknown;
    readonly httpResponse?: ProvenanceResponse;
    readonly httpThrow?: Error;
    readonly envelope?: RequestEnvelope;
}

const buildGraph = (input: BranchCaseInput) => {
    const snapshot = input.snapshot ?? buildSnapshot();
    const get = vi.fn((): Promise<unknown> => {
        if (input.httpThrow !== undefined) return Promise.reject(input.httpThrow);
        if (input.httpResponse !== undefined) return Promise.resolve(input.httpResponse);
        return Promise.reject(new Error('test misconfigured: no httpResponse and no httpThrow'));
    });
    const client: AgentHttpClient = { get };
    const synth = vi.fn() as unknown as Synthesizer;

    const graph = createBriefingGraph({
        retrieve: { client: buildClient(snapshot), token: TOKEN, siteId: 'default' },
        synthesize: { synthesizer: synth },
        verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        medChange: {
            client,
            token: TOKEN,
            siteId: 'default',
            openEmrBaseUrl: 'http://openemr',
        },
    });
    return { graph, get, synth, snapshot };
};

const happyResponse = (overrides: Partial<ProvenanceResponse['provenance']> = {}): ProvenanceResponse => ({
    provenance: {
        prescriptionId: 7001,
        drugName: 'Lisinopril',
        prescriber: 'Patel, Maya',
        prescribingDate: '2026-03-20',
        indication: 'new-onset hypertension',
        doseAdjustments: [{ dose: '10 mg', date: '2026-03-20' }],
        ...overrides,
    },
});

describe('§4.3 medChangeBranch', () => {
    it('renders the documented fields and the synthesizer is NOT called', async () => {
        const { graph, synth } = buildGraph({ httpResponse: happyResponse() });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(synth).not.toHaveBeenCalled();
        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.accepted[0]?.category).toBe('medication_change');
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toContain('Lisinopril');
        expect(seg?.text).toContain('Patel, Maya');
        expect(seg?.text).toContain('new-onset hypertension');
        expect(seg?.text).toContain('2026-03-20');
        expect(seg?.redacted).toBe(false);
    });

    it('omits indication when the source has none', async () => {
        const { graph } = buildGraph({
            snapshot: buildSnapshot({ indication: null }),
            httpResponse: happyResponse({ indication: null }),
        });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.verified?.passed).toBe(true);
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toContain('Patel, Maya');
        expect(seg?.text).not.toContain('hypertension');
    });

    it('omits prescriber when the source has none', async () => {
        const { graph } = buildGraph({
            snapshot: buildSnapshot({ prescriber: null }),
            httpResponse: happyResponse({ prescriber: null }),
        });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.verified?.passed).toBe(true);
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toContain('Lisinopril');
        expect(seg?.text).toContain('new-onset hypertension');
        expect(seg?.text).not.toContain('prescribed by');
    });

    it('renders a connector segment with no claim on 404', async () => {
        const { graph } = buildGraph({ httpThrow: new AgentHttpError(404, '') });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.verified?.accepted).toHaveLength(0);
        expect(out.verified?.rejected).toHaveLength(0);
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toMatch(/no prescription record/i);
        expect(seg?.redacted).toBe(false);
    });

    it('renders a "not available" connector when the endpoint fails open', async () => {
        const { graph } = buildGraph({ httpThrow: new AgentNetworkError('unreachable') });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.verified?.accepted).toHaveLength(0);
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toMatch(/not available right now/i);
    });

    it('handles a malformed medicationId by falling back to a connector', async () => {
        const { graph } = buildGraph({ httpResponse: happyResponse() });
        const envelope: RequestEnvelope = {
            ...followUpEnvelope(),
            followUp: { type: 'medication_change', medicationId: 'NotAValidKey' },
        };

        const out = await graph.invoke({ envelope });

        expect(out.verified?.accepted).toHaveLength(0);
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toMatch(/not in a recognizable format/i);
    });
});
