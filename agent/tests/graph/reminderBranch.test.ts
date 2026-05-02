import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { RequestEnvelope } from '../../src/graph/types.js';
import type { AgentHttpClient } from '../../src/tools/agentHttp.js';
import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

/**
 * §4.6.5 reminder-detail branch — graph-level integration test.
 *
 * The branch fires only when `followUp.type === 'reminder_detail'`
 * AND `reminderDetail` deps are wired. Each case here builds a graph
 * with a stub `AgentHttpClient` returning the appropriate JSON for
 * the reminder_detail endpoint, then runs the graph end-to-end to
 * confirm:
 *   - the synthesizer mock is *not* called (the branch bypasses it)
 *   - the verifier accepts/rejects per the deterministic
 *     `matchesReminder` rule
 *   - failure modes (404, 5xx, malformed id) emit a connector
 *     segment with an empty ledger
 */

const TOKEN = 'tok';
const PATIENT_PID = 42;
const PATIENT_RECORD_ID = '42';
const REMINDER_ID = '85001';

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
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
    reminders: [
        {
            item: 'mammogram',
            itemTitle: 'Mammogram screening',
            category: 'screening',
            categoryTitle: 'Screening',
            dueStatus: 'overdue',
            createdAt: '2025-11-01',
            reminderId: 85001,
            source: sourceRef('Task', REMINDER_ID),
        },
    ],
    medications: [],
});

const buildSnapshotClient = (snapshot: unknown): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(snapshot)),
});

const followUpEnvelope = (reminderKey = `Task:${REMINDER_ID}`): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PATIENT_PID, uuid: 'p-1' },
    task: 'follow_up',
    followUp: { type: 'reminder_detail', reminderId: reminderKey },
});

interface DetailResponse {
    readonly detail: {
        readonly reminderId: number;
        readonly item: string;
        readonly itemTitle: string;
        readonly category: string;
        readonly categoryTitle: string;
        readonly dueStatus: string;
        readonly createdAt: string | null;
        readonly ruleDescription: string | null;
    };
}

const happyResponse = (overrides: Partial<DetailResponse['detail']> = {}): DetailResponse => ({
    detail: {
        reminderId: 85001,
        item: 'mammogram',
        itemTitle: 'Mammogram screening',
        category: 'screening',
        categoryTitle: 'Screening',
        dueStatus: 'overdue',
        createdAt: '2025-11-01',
        ruleDescription: 'Annual mammogram per USPSTF B recommendation',
        ...overrides,
    },
});

interface BranchCaseInput {
    readonly httpResponse?: DetailResponse;
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
        reminderDetail: {
            client,
            token: TOKEN,
            siteId: 'default',
            openEmrBaseUrl: 'http://openemr',
        },
    });
    return { graph, get, synth };
};

describe('§4.6.5 reminderBranch', () => {
    it('renders the resolved title + due status + rule description, synthesizer NOT called', async () => {
        const { graph, synth } = buildGraph({ httpResponse: happyResponse() });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(synth).not.toHaveBeenCalled();
        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.accepted[0]?.category).toBe('reminder');
        const seg = out.formatted?.segments[0];
        expect(seg?.text).toContain('Mammogram screening');
        expect(seg?.text).toContain('overdue');
        expect(seg?.text).toContain('USPSTF');
        expect(seg?.redacted).toBe(false);
    });

    it('renders a connector segment with no claim on 404', async () => {
        const { graph } = buildGraph({ httpThrow: new AgentHttpError(404, '') });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.formatted?.segments).toHaveLength(1);
        expect(out.formatted?.segments[0]?.text).toContain('No reminder record found');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
        expect(out.verified?.accepted).toHaveLength(0);
    });

    it('renders a "not available" connector segment when the detail endpoint fails open', async () => {
        const { graph } = buildGraph({ httpThrow: new AgentNetworkError('boom') });

        const out = await graph.invoke({ envelope: followUpEnvelope() });

        expect(out.formatted?.segments[0]?.text).toContain('not available');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
    });

    it('rejects a malformed reminderId without invoking the HTTP client', async () => {
        const { graph, get } = buildGraph({ httpResponse: happyResponse() });

        const out = await graph.invoke({
            envelope: followUpEnvelope('not-a-key'),
        });

        expect(get).not.toHaveBeenCalled();
        expect(out.formatted?.segments[0]?.text).toContain('not in a recognizable format');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
    });
});
