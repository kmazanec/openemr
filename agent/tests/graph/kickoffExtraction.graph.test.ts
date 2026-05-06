import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type {
    SupervisorDecide,
    SupervisorDecideInput,
} from '../../src/graph/nodes/supervisor.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { ClaimLedger, RequestEnvelope, SupervisorDecision } from '../../src/graph/types.js';
import { initialPipelineState, type PipelineState } from '../../src/pipeline/state.js';
import type { PipelineRunner } from '../../src/server/routes/extract.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

/**
 * §B.9 graph-level integration: wire a real `createBriefingGraph` with
 * a stub supervisor that picks `kickoffExtraction` on the first
 * iteration and `synthesize` on the second. Confirm the supervisor's
 * handoff routes through the real `kickoffExtraction` node (not the
 * §A.7 stub) when the runner-supplied deps slot is wired, and that the
 * pipeline's terminal state lands on `state.kickoffExtractionResults`
 * for the supervisor's next iteration to read.
 *
 * Real-Anthropic end-to-end coverage (fixture lab PDF + real vision
 * call) is the §B.10 eval suite's responsibility per the architecture's
 * "real model in CI" gate. This test asserts the graph wiring contract,
 * not model quality.
 */

const PID = 42;

const sourceRef = (recordId: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: recordId,
    locator: { field },
    quote: recordId,
});

const buildSnapshot = (): unknown => ({
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        source: sourceRef('42', 'patient.name'),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
});

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-patel', fhirUser: 'https://emr/Practitioner/u-patel' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'default_briefing',
};

const cannedLedger: ClaimLedger = { claims: [] };

const buildSnapshotClient = (snapshot: unknown): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(snapshot)),
});

const buildSynthesizer = (): Synthesizer =>
    vi.fn(() =>
        Promise.resolve({
            draft: { segments: [{ text: 'Briefing.', claimIds: [] }] },
            ledger: cannedLedger,
        }),
    );

/**
 * Two-step supervisor: pick `kickoffExtraction` with the supplied args
 * the first time, then `synthesize` so the graph can terminate. After
 * `kickoffExtraction` runs, the supervisor sees the appended result and
 * routes to synthesize — the standard "extracted, now answer" pattern.
 */
const buildScriptedSupervisor = (kickoffArgs: Record<string, unknown>): SupervisorDecide => {
    return (input: SupervisorDecideInput): Promise<SupervisorDecision> => {
        if (input.observation.kickoffExtractionResultsCount === 0) {
            return Promise.resolve({
                handoff: 'kickoffExtraction',
                reason: 'unprocessed document_uuid in this turn',
                narration: 'test narration',
                args: kickoffArgs,
            });
        }
        return Promise.resolve({
            handoff: 'synthesize',
            reason: 'artifact landed; ready to answer',
            narration: 'test narration',
        });
    };
};

const buildPipelineRunner = (
    finalState: PipelineState,
    updates: readonly { node: string; payload: Record<string, unknown> }[] = [],
): PipelineRunner => {
    const iterable: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: async function* () {
            await Promise.resolve();
            for (const u of updates) {
                yield ['updates', { [u.node]: u.payload }];
            }
            yield ['values', finalState];
        },
    };
    return { stream: vi.fn(() => Promise.resolve(iterable)) };
};

const persistedState = (artifactId: string): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-uuid-1',
        docType: 'lab_pdf',
        pid: PID,
        triggerSource: 'panel',
    }),
    artifactId,
    status: 'persisted',
});

describe('§B.9 kickoffExtraction routes through the briefing graph', () => {
    it('picks the real kickoff node when deps are wired and appends a persisted result', async () => {
        const runner = buildPipelineRunner(
            persistedState('art-graph-1'),
            [
                { node: 'rasterize', payload: { pages: [{}, {}] } },
                { node: 'persist', payload: { artifactId: 'art-graph-1' } },
            ],
        );
        const synth = buildSynthesizer();
        const graph = createBriefingGraph({
            retrieveChart: {
                client: buildSnapshotClient(buildSnapshot()),
                token: 'tok',
                siteId: 'default',
            },
            supervisor: {
                decide: buildScriptedSupervisor({
                    document_uuid: 'doc-uuid-1',
                    doc_type: 'lab_pdf',
                }),
            },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            kickoffExtraction: {
                pipeline: runner,
                openemrToken: 'tok',
                openemrSiteId: 'default',
                conversationId: 'c-1',
            },
        });

        const out = await graph.invoke({ envelope });

        expect(out.kickoffExtractionResults).toHaveLength(1);
        expect(out.kickoffExtractionResults[0]).toMatchObject({
            documentUuid: 'doc-uuid-1',
            docType: 'lab_pdf',
            status: 'persisted',
            artifactId: 'art-graph-1',
        });
        // The synthesize stub still ran on the second iteration so the
        // graph terminates through verify/format/persist.
        expect(synth).toHaveBeenCalledOnce();
        // Supervisor decision history records both handoffs in order.
        const handoffs = out.supervisorDecisionHistory.map((d) => d.handoff);
        expect(handoffs).toEqual(['kickoffExtraction', 'synthesize']);
    });

    it('falls back to the §A.7 stub when no kickoffExtraction deps wired', async () => {
        // The stub returns an empty update so `kickoffExtractionResults`
        // stays at length 0 — reusing the standard scripted supervisor
        // would loop forever. Instead, hand-build a one-shot supervisor
        // that goes straight to synthesize so the graph terminates.
        const synth = buildSynthesizer();
        const decideStraightToSynthesize: SupervisorDecide = () =>
            Promise.resolve({
                handoff: 'synthesize',
                reason: 'no kickoff deps wired; route directly to synthesize',
                narration: 'test narration',
            });
        const graph = createBriefingGraph({
            retrieveChart: {
                client: buildSnapshotClient(buildSnapshot()),
                token: 'tok',
                siteId: 'default',
            },
            supervisor: { decide: decideStraightToSynthesize },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            // No kickoffExtraction deps — the stub would run if the
            // supervisor picked the handoff. The contract this test
            // pins is "the graph still compiles and runs without a
            // pipeline wired", which would be load-bearing in the
            // (current) precompute path that doesn't construct a
            // pipeline.
        });

        const out = await graph.invoke({ envelope });

        expect(out.kickoffExtractionResults).toHaveLength(0);
        expect(synth).toHaveBeenCalledOnce();
    });
});
