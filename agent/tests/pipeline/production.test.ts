/**
 * §B.8 Production pipeline-runner factory test.
 *
 * The factory composes per-call `PipelineDeps` from boot-time deps + a
 * `PipelineCallContext`. The compiled graph is then driven by LangGraph's
 * own machinery — already covered by `pipeline.e2e.test.ts`. This file's
 * job is asserting the wiring contract: per-call values (token, siteId,
 * canonicalExt, conversationId) reach the right deps slots, and a fresh
 * graph is compiled per invocation so concurrent invocations don't
 * cross-contaminate.
 */

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { buildProductionPipelineRunner } from '../../src/pipeline/production.js';
import type { ProductionPipelineDeps } from '../../src/pipeline/production.js';
import type { PipelineCallContext } from '../../src/server/routes/extract.js';
import type { Demographics, ChartSnapshot } from '../../src/snapshot/types.js';
import { initialPipelineState, type PipelineState } from '../../src/pipeline/state.js';

const noopLogger = pino({ level: 'silent' });

const dummyDemographics = (): Demographics => ({
    pid: 4242,
    uuid: 'u',
    displayName: 'X',
    sex: 'unknown',
    dateOfBirth: '2000-01-01',
    ageYears: 26,
    source: { source_type: 'chart', source_id: 'x', locator: {}, quote: 'q' },
});

const dummyChart = (): ChartSnapshot => ({
    patient: dummyDemographics(),
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
});

const buildDeps = (): {
    deps: ProductionPipelineDeps;
    fetchDemoBuilds: PipelineCallContext[];
    fetchSnapBuilds: PipelineCallContext[];
} => {
    const fetchDemoBuilds: PipelineCallContext[] = [];
    const fetchSnapBuilds: PipelineCallContext[] = [];
    const buildFetchChartDemographics = (ctx: PipelineCallContext) => {
        fetchDemoBuilds.push(ctx);
        return () => Promise.resolve(dummyDemographics());
    };
    const buildFetchChartSnapshot = (ctx: PipelineCallContext) => {
        fetchSnapBuilds.push(ctx);
        return () => Promise.resolve(dummyChart());
    };
    const deps: ProductionPipelineDeps = {
        artifactStore: {
            insertArtifact: vi.fn(),
            updateArtifactStatus: vi.fn(),
            findArtifactByDocumentHash: vi.fn(() => Promise.resolve(null)),
            claimDocumentLock: vi.fn(),
            searchArtifacts: vi.fn(() => Promise.resolve([])),
            recordDisposition: vi.fn(),
            getDispositions: vi.fn(() => Promise.resolve([])),
        },
        openemrSpaces: {
            bucket: 'b',
            putObject: vi.fn(),
            getObject: vi.fn(),
            deleteObject: vi.fn(),
            presignGetUrl: vi.fn(),
            presignPutUrl: vi.fn(),
            destroy: vi.fn(),
        },
        agentSpaces: {
            bucket: 'b',
            putObject: vi.fn(),
            getObject: vi.fn(),
            deleteObject: vi.fn(),
            presignGetUrl: vi.fn(),
            presignPutUrl: vi.fn(),
            destroy: vi.fn(),
        },
        rasterizer: {
            pageCount: vi.fn(() => Promise.resolve(1)),
            rasterize: vi.fn(() => Promise.resolve([])),
        },
        visionInvoker: { invoke: vi.fn(() => Promise.resolve({ extraction: {} })) },
        documentReferenceClient: {
            writeDocumentReference: vi.fn(() =>
                Promise.resolve({ documentUuid: 'u' }),
            ),
        },
        buildFetchChartDemographics,
        buildFetchChartSnapshot,
        transientPrefix: 'transient',
        bucketName: 'cdn.test.dev',
        artifactIdGenerator: () => 'artifact-test',
        logger: noopLogger,
    };
    return { deps, fetchDemoBuilds, fetchSnapBuilds };
};

const buildInput = (): PipelineState =>
    initialPipelineState({
        documentUuid: 'placeholder-1',
        docType: 'lab_pdf',
        pid: 4242,
        triggerSource: 'panel',
    });

describe('buildProductionPipelineRunner', () => {
    it('threads PipelineCallContext into the per-call fetch boundaries', async () => {
        const { deps, fetchDemoBuilds, fetchSnapBuilds } = buildDeps();
        const runner = buildProductionPipelineRunner(deps);
        const ctx: PipelineCallContext = {
            openemrToken: 'jwt-1',
            openemrSiteId: 'default',
            canonicalExt: 'pdf',
            conversationId: 'conv-1',
        };

        // We don't iterate the stream — we only assert the deps were
        // composed with the right context. LangGraph's `stream()` does
        // the work lazily; constructing the graph is enough to fire
        // both `buildFetch*` factories because they're called inside
        // the `PipelineDeps` object literal.
        await runner.stream(buildInput(), ctx);

        expect(fetchDemoBuilds).toHaveLength(1);
        expect(fetchDemoBuilds[0]).toEqual(ctx);
        expect(fetchSnapBuilds).toHaveLength(1);
        expect(fetchSnapBuilds[0]).toEqual(ctx);
    });

    it('builds a fresh graph per invocation so concurrent calls do not share deps', async () => {
        const { deps, fetchDemoBuilds } = buildDeps();
        const runner = buildProductionPipelineRunner(deps);
        const ctxA: PipelineCallContext = {
            openemrToken: 'jwt-A',
            openemrSiteId: 'default',
            canonicalExt: 'pdf',
        };
        const ctxB: PipelineCallContext = {
            openemrToken: 'jwt-B',
            openemrSiteId: 'default',
            canonicalExt: 'png',
        };
        await Promise.all([
            runner.stream(buildInput(), ctxA),
            runner.stream(buildInput(), ctxB),
        ]);
        expect(fetchDemoBuilds).toHaveLength(2);
        const tokens = fetchDemoBuilds.map((c) => c.openemrToken).sort();
        expect(tokens).toEqual(['jwt-A', 'jwt-B']);
    });

    it('omits conversationId when the context does not supply one', async () => {
        const { deps, fetchDemoBuilds } = buildDeps();
        const runner = buildProductionPipelineRunner(deps);
        await runner.stream(buildInput(), {
            openemrToken: 'jwt-1',
            openemrSiteId: 'default',
            canonicalExt: 'pdf',
        });
        const ctx = fetchDemoBuilds[0]!;
        expect(ctx).not.toHaveProperty('conversationId');
    });
});
