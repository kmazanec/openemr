import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import {
    CHART_DELIMITER,
    buildUserMessage,
} from '../../src/graph/synthesize.prompt.js';
import type {
    BriefingSnapshot,
    ClaimLedger,
    PriorTurnContext,
    RequestEnvelope,
} from '../../src/graph/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

/**
 * §A.8 end-to-end gate. Drives a UC1 default-briefing turn through
 * the full graph (RetrieveChart → supervisor → synthesize → verify
 * → format → persist) with `priorTurnContext.turns = []` — the
 * default-briefing shape. The test pins three things together:
 *
 *  - the synthesize node receives `priorTurnContext` from
 *    `BriefingState`,
 *  - the prompt builder produces a message that's byte-equivalent
 *    to the pre-A.8 shape when `turns` is empty (no token cost on
 *    the dominant path),
 *  - the verifier still accepts a `source_type: 'chart'` claim
 *    end-to-end.
 *
 * The point is to prove the delimiter wrapping logic doesn't fire
 * spuriously on the default-briefing path. The "non-empty turns"
 * shape lives in `synthesizePrompt.test.ts` — that test pins the
 * positive case unit-style; this test pins that the integration
 * path's empty case is byte-stable.
 */

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

const sourceRef = (sourceId: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

const happyPathSnapshot: BriefingSnapshot = {
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        ageYears: 67,
        source: sourceRef('42', 'patient.name'),
    },
    appointment: null,
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: sourceRef('c-1', 'condition.code'),
        },
    ],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
};

const cannedLedger: ClaimLedger = {
    claims: [
        {
            id: 'c-1',
            text: 'Patient has type 2 diabetes (E11.9)',
            category: 'diagnosis',
            sourceReferences: [sourceRef('c-1', 'condition.code')],
            safetyCritical: false,
        },
    ],
};

interface Captured {
    readonly priorTurnContext: PriorTurnContext;
    readonly snapshot: BriefingSnapshot;
}

const buildCapturingSynth = (sink: { value: Captured | null }): Synthesizer => {
    const impl: Synthesizer = (input) => {
        sink.value = {
            priorTurnContext: input.priorTurnContext,
            snapshot: input.snapshot,
        };
        return Promise.resolve({
            draft: {
                segments: [
                    { text: 'Mrs. Patel has type 2 diabetes.', claimIds: ['c-1'] },
                ],
            },
            ledger: cannedLedger,
        });
    };
    return vi.fn(impl);
};

const buildClient = (): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(happyPathSnapshot)),
});

describe('§A.8 end-to-end: default briefing with empty priorTurnContext', () => {
    it('threads priorTurnContext.turns=[] through the graph to the synthesizer', async () => {
        // The runner-side prepareBriefingState (§A.5) seeds default
        // briefings with `{ turns: [] }`; the BriefingState
        // annotation defaults the slot to that value too. Either
        // way, the synthesize node must forward it to the
        // synthesizer call so the prompt builder sees an empty
        // priorTurnContext.
        const captured: { value: Captured | null } = { value: null };
        const graph = createBriefingGraph({
            retrieveChart: { client: buildClient(), token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: buildCapturingSynth(captured) },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope });

        expect(captured.value).not.toBeNull();
        expect(captured.value?.priorTurnContext).toEqual({ turns: [] });
        expect(out.verified?.passed).toBe(true);
    });

    it('produces a user message byte-equivalent to the no-arg shape when turns are empty', async () => {
        // The byte-stability assertion is the load-bearing part —
        // an empty priorTurnContext must not introduce extra
        // tokens into the prompt, so default-briefing latency and
        // cost stay where they were pre-A.8.
        const captured: { value: Captured | null } = { value: null };
        const graph = createBriefingGraph({
            retrieveChart: { client: buildClient(), token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: buildCapturingSynth(captured) },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        await graph.invoke({ envelope });

        const captureValue = captured.value;
        if (captureValue === null) throw new Error('synthesizer was not invoked');
        const messageWithEmpty = buildUserMessage(captureValue.snapshot, captureValue.priorTurnContext);
        const messageWithoutArg = buildUserMessage(captureValue.snapshot);
        expect(messageWithEmpty).toBe(messageWithoutArg);
        // And the delimiter is still on both sides.
        expect(messageWithEmpty).toContain(`<${CHART_DELIMITER}>`);
        expect(messageWithEmpty).toContain(`</${CHART_DELIMITER}>`);
    });

    it('verifier accepts the chart-source claim end-to-end', async () => {
        // §A.8 checkbox: "UC1 default briefing produces a response
        // whose claims all carry source_type: 'chart', the
        // verifier accepts them, and the formatter groups them
        // under 'What's in the chart'." The verify gate is the
        // load-bearing part here — the format-grouping check
        // lives in format.test.ts.
        const captured: { value: Captured | null } = { value: null };
        const graph = createBriefingGraph({
            retrieveChart: { client: buildClient(), token: TOKEN, siteId: 'default' },
            synthesize: { synthesizer: buildCapturingSynth(captured) },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope });

        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.accepted[0]?.sourceReferences[0]?.source_type).toBe('chart');
        expect(out.verified?.rejected).toHaveLength(0);
        expect(out.formatted?.segments[0]?.redacted).toBe(false);
    });
});
