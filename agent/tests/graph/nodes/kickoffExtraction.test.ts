import { describe, expect, it, vi } from 'vitest';

import { createKickoffExtraction } from '../../../src/graph/nodes/kickoffExtraction.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type {
    BriefingSnapshot,
    KickoffExtractionErrorCode,
    KickoffExtractionResult,
    RequestEnvelope,
    SupervisorDecision,
} from '../../../src/graph/types.js';
import { KICKOFF_EXTRACTION_ERROR_CODES } from '../../../src/graph/types.js';
import { initialPipelineState, type PipelineState } from '../../../src/pipeline/state.js';
import type { PipelineRunner } from '../../../src/server/routes/extract.js';
import type { PipelineStreamEvent } from '../../../src/server/pipelineStream.js';

/**
 * §B.9 unit tests for the conversational graph's `kickoffExtraction`
 * node. The node calls the production `PipelineRunner` synchronously,
 * forwards `pipeline.*.complete` events through an injectable
 * `onPipelineEvent` callback, and appends a summary projection of the
 * pipeline's terminal state to `state.kickoffExtractionResults`.
 *
 * The end-to-end real-pipeline test that drives a fixture lab PDF
 * through the full graph + real Anthropic vision call lives at
 * `agent/tests/pipeline/pipeline.e2e.test.ts` (B.7); the kickoff node
 * itself is exercised here against a stub runner so the per-MR Vitest
 * gate stays deterministic and cost-free.
 */

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const sourceRef = (id: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field },
    quote: id,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
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
    labHistory: null,
};

const decision = (args: Record<string, unknown> | undefined): SupervisorDecision => ({
    handoff: 'kickoffExtraction',
    reason: 'panel uploaded a lab PDF for this patient',
    ...(args !== undefined ? { args } : {}),
});

const baseState = (overrides?: Partial<BriefingState>): BriefingState => ({
    envelope,
    priorTurnContext: { turns: [] },
    snapshot,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 1,
    retrieveChartArgs: null,
    documentEvidenceArgs: null,
    documentEvidenceSnippets: null,
    documentEvidenceArtifactConfidence: null,
    evidenceRetrieverArgs: null,
    evidenceRetrieverOutput: null,
    supervisorIterations: 1,
    supervisorDecisionHistory: [
        decision({ document_uuid: 'doc-uuid-1', doc_type: 'lab_pdf' }),
    ],
    capHit: false,
    kickoffExtractionResults: [],
    ...overrides,
});

interface ScriptedChunk {
    readonly mode: 'updates' | 'values';
    readonly payload: unknown;
}

/**
 * Wrap a sync chunk array as an `AsyncIterable` so the runner's
 * declared `Promise<AsyncIterable<unknown>>` shape is honored without
 * the test's generator carrying a redundant `await`.
 */
const asAsyncIterable = (chunks: readonly ScriptedChunk[]): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: async function* () {
        await Promise.resolve();
        for (const c of chunks) {
            yield [c.mode, c.payload];
        }
    },
});

const stubRunner = (chunks: readonly ScriptedChunk[]): PipelineRunner => ({
    stream: vi.fn(() => Promise.resolve(asAsyncIterable(chunks))),
});

const persistedState = (artifactId: string): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-uuid-1',
        docType: 'lab_pdf',
        pid: 42,
        triggerSource: 'panel',
    }),
    artifactId,
    status: 'persisted',
});

const failedState = (
    code: 'cost-cap-exceeded' | 'patient_mismatch' | 'schema_invalid' | 'persist_failed',
    message: string,
    artifactId: string | null = null,
): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-uuid-1',
        docType: 'lab_pdf',
        pid: 42,
        triggerSource: 'panel',
    }),
    status: 'failed',
    artifactId,
    errors: [{ code, message }],
});

describe('kickoffExtraction node (§B.9)', () => {
    it('appends a persisted result on pipeline success and forwards pipeline events', async () => {
        const events: PipelineStreamEvent[] = [];
        const runner = stubRunner([
            { mode: 'updates', payload: { rasterize: { pages: [{}, {}, {}] } } },
            { mode: 'updates', payload: { vision: { schema: { ok: true } } } },
            { mode: 'updates', payload: { persist: { artifactId: 'art-1' } } },
            { mode: 'values', payload: persistedState('art-1') },
        ]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
            conversationId: 'c-1',
            onPipelineEvent: (e) => {
                events.push(e);
            },
        });

        const update = await node(baseState());

        expect(update.kickoffExtractionResults).toEqual<readonly KickoffExtractionResult[]>([
            {
                documentUuid: 'doc-uuid-1',
                docType: 'lab_pdf',
                status: 'persisted',
                artifactId: 'art-1',
                errorCode: null,
            },
        ]);
        expect(events.map((e) => e.type)).toEqual([
            'pipeline.start',
            'pipeline.rasterize.complete',
            'pipeline.vision.complete',
            'pipeline.persist.complete',
            'pipeline.exit',
        ]);
        const exit = events.at(-1);
        expect(exit?.type).toBe('pipeline.exit');
        if (exit?.type === 'pipeline.exit') {
            expect(exit.status).toBe('persisted');
            expect(exit.artifactId).toBe('art-1');
        }
    });

    it('appends a failed result on pipeline failure with the first error code', async () => {
        const events: PipelineStreamEvent[] = [];
        const runner = stubRunner([
            {
                mode: 'updates',
                payload: { rasterize: { errors: [{ code: 'cost-cap-exceeded', message: 'over $1' }] } },
            },
            { mode: 'values', payload: failedState('cost-cap-exceeded', 'over $1') },
        ]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
            onPipelineEvent: (e) => {
                events.push(e);
            },
        });

        const update = await node(baseState());

        expect(update.kickoffExtractionResults).toEqual<readonly KickoffExtractionResult[]>([
            {
                documentUuid: 'doc-uuid-1',
                docType: 'lab_pdf',
                status: 'failed',
                artifactId: null,
                errorCode: 'cost-cap-exceeded',
            },
        ]);
        const errorEvent = events.find((e) => e.type === 'pipeline.error');
        expect(errorEvent).toBeDefined();
        if (errorEvent?.type === 'pipeline.error') {
            expect(errorEvent.code).toBe('cost-cap-exceeded');
        }
        const exit = events.at(-1);
        expect(exit?.type).toBe('pipeline.exit');
        if (exit?.type === 'pipeline.exit') {
            expect(exit.status).toBe('failed');
        }
    });

    it('appends a failed result with errorCode=invalid_args when args are malformed', async () => {
        // No supervisor decision args at all → schema parse fails.
        const runner = stubRunner([]);
        const streamSpy = runner.stream as ReturnType<typeof vi.fn>;
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });

        const update = await node(baseState({
            supervisorDecisionHistory: [decision(undefined)],
        }));

        expect(update.kickoffExtractionResults?.[0]?.status).toBe('failed');
        expect(update.kickoffExtractionResults?.[0]?.errorCode).toBe('invalid_args');
        // Pipeline must not have been invoked when args are invalid.
        expect(streamSpy).not.toHaveBeenCalled();
    });

    it('rejects an args payload missing document_uuid', async () => {
        const runner = stubRunner([]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });

        const update = await node(baseState({
            supervisorDecisionHistory: [decision({ doc_type: 'lab_pdf' })],
        }));

        expect(update.kickoffExtractionResults?.[0]?.errorCode).toBe('invalid_args');
    });

    it('rejects an args payload with an unknown doc_type', async () => {
        const runner = stubRunner([]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });

        const update = await node(baseState({
            supervisorDecisionHistory: [
                decision({ document_uuid: 'doc-uuid-1', doc_type: 'discharge_summary' }),
            ],
        }));

        expect(update.kickoffExtractionResults?.[0]?.errorCode).toBe('invalid_args');
    });

    it('appends pipeline_runtime_error when the runner throws mid-stream', async () => {
        const throwingIterable: AsyncIterable<unknown> = {
            [Symbol.asyncIterator]: async function* () {
                await Promise.resolve();
                yield ['updates', { rasterize: { pages: [{}] } }];
                throw new Error('synthetic stream failure');
            },
        };
        const runner: PipelineRunner = {
            stream: () => Promise.resolve(throwingIterable),
        };
        const events: PipelineStreamEvent[] = [];
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
            onPipelineEvent: (e) => {
                events.push(e);
            },
        });

        const update = await node(baseState());

        expect(update.kickoffExtractionResults?.[0]?.errorCode).toBe('pipeline_runtime_error');
        const errorEvent = events.find((e) => e.type === 'pipeline.error');
        expect(errorEvent).toBeDefined();
    });

    it('appends pipeline_no_terminal_state when no values chunk arrives', async () => {
        const runner = stubRunner([
            { mode: 'updates', payload: { rasterize: { pages: [{}] } } },
            // No `values` chunk — pipeline never reached terminal.
        ]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });

        const update = await node(baseState());

        expect(update.kickoffExtractionResults?.[0]?.status).toBe('failed');
        expect(update.kickoffExtractionResults?.[0]?.errorCode).toBe('pipeline_no_terminal_state');
    });

    it('threads the per-call context (token, siteId, canonicalExt, conversationId) into the runner', async () => {
        const runner = stubRunner([
            { mode: 'values', payload: persistedState('art-2') },
        ]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok-abc',
            openemrSiteId: 'site-7',
            canonicalExt: 'png',
            conversationId: 'conv-9',
        });

        await node(baseState());

        const call = (runner.stream as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call).toBeDefined();
        if (call === undefined) throw new Error('unreachable');
        const initialState = call[0] as PipelineState;
        const ctx = call[1] as Record<string, unknown>;
        const config = call[2] as Record<string, unknown> | undefined;
        expect(initialState.documentUuid).toBe('doc-uuid-1');
        expect(initialState.docType).toBe('lab_pdf');
        expect(initialState.pid).toBe(42);
        expect(initialState.triggerSource).toBe('panel');
        expect(ctx).toEqual({
            openemrToken: 'tok-abc',
            openemrSiteId: 'site-7',
            canonicalExt: 'png',
            conversationId: 'conv-9',
        });
        expect(config?.['streamMode']).toEqual(['updates', 'values']);
    });

    it('defaults canonicalExt to pdf when omitted', async () => {
        const runner = stubRunner([{ mode: 'values', payload: persistedState('art-3') }]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });

        await node(baseState());

        const call = (runner.stream as ReturnType<typeof vi.fn>).mock.calls[0];
        const ctx = call?.[1] as { canonicalExt: string };
        expect(ctx.canonicalExt).toBe('pdf');
    });

    it('appends without forwarding events when onPipelineEvent is omitted', async () => {
        const runner = stubRunner([{ mode: 'values', payload: persistedState('art-4') }]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });

        const update = await node(baseState());

        expect(update.kickoffExtractionResults?.[0]?.status).toBe('persisted');
    });

    it('preserves previously appended results', async () => {
        const runner = stubRunner([{ mode: 'values', payload: persistedState('art-5') }]);
        const node = createKickoffExtraction({
            pipeline: runner,
            openemrToken: 'tok',
            openemrSiteId: 'default',
        });
        const prior: KickoffExtractionResult = {
            documentUuid: 'doc-uuid-prior',
            docType: 'intake_form',
            status: 'persisted',
            artifactId: 'art-prior',
            errorCode: null,
        };

        const update = await node(baseState({ kickoffExtractionResults: [prior] }));

        expect(update.kickoffExtractionResults).toHaveLength(2);
        expect(update.kickoffExtractionResults?.[0]).toBe(prior);
        expect(update.kickoffExtractionResults?.[1]?.artifactId).toBe('art-5');
    });

    it('exposes the same error-code surface as the pipeline (contract pin)', () => {
        // The kickoffExtraction node's KickoffExtractionErrorCode union
        // forwards every PipelineErrorCode plus three node-only codes.
        // The pin below catches a pipeline-side addition that forgets
        // to update the conversational graph's surface.
        const expected: readonly KickoffExtractionErrorCode[] = [
            'cost-cap-exceeded',
            'rasterize_failed',
            'storage-unreachable',
            'rate-limited',
            'schema_invalid',
            'patient_mismatch',
            'persist_failed',
            'invalid_args',
            'pipeline_runtime_error',
            'pipeline_no_terminal_state',
        ];
        expect([...KICKOFF_EXTRACTION_ERROR_CODES]).toEqual([...expected]);
    });
});
