/**
 * §B.8 Production wiring for the ingestion pipeline.
 *
 * The compiled `pipelineGraph` from `index.ts` is built from per-node
 * `*Deps` interfaces. A few of those deps are per-invocation values
 * (the OpenEMR JWT the persist node uses for the Tier-1 callback, the
 * canonical-extension the rasterize and persist nodes key off, the
 * conversation id for the Tier-1 disclosure event), so production
 * cannot bake the deps once and reuse them. Instead, this factory
 * takes the boot-time pieces (Spaces clients, rasterizer, vision
 * invoker, artifact store, document-reference client, chart-fetch
 * boundaries) and returns a `PipelineRunner` whose `stream()` builds
 * a fresh graph per call.
 *
 * Boot wires this once in `start()`; the `/v1/agent/extract` route is
 * the only consumer today.
 */

import type { Logger } from 'pino';

import type { PipelineRunner, PipelineCallContext } from '../server/routes/extract.js';
import type { ExtractionArtifactStore } from '../state/extractionArtifacts.js';
import type { Demographics, ChartSnapshot } from '../snapshot/types.js';
import type { CanonicalDocumentFallbackClient } from '../storage/canonicalDocumentFallback.js';
import type { SpacesClient } from '../storage/spaces.js';
import type { OpenEmrDocumentReferenceClient } from '../storage/openemrDocumentReferenceClient.js';
import type { Rasterizer } from './rasterizer.js';
import type { VisionInvocation } from './nodes/vision.js';

import { createBboxSnapper, defaultFetchPageBytes, type BboxSnapperLike } from './bboxSnap.js';
import { createPipelineGraph, type PipelineDeps } from './index.js';
import type { PipelineState } from './state.js';

export interface ProductionPipelineDeps {
    readonly artifactStore: ExtractionArtifactStore;
    readonly openemrSpaces: SpacesClient;
    readonly agentSpaces: SpacesClient;
    readonly rasterizer: Rasterizer;
    readonly visionInvoker: VisionInvocation;
    readonly documentReferenceClient: OpenEmrDocumentReferenceClient;
    /**
     * Optional fallback bytes-fetcher for chart documents that
     * aren't in the Spaces canonical bucket — typically because they
     * were uploaded via OpenEMR's legacy Documents UI rather than
     * through the agent's chat panel. When wired, the rasterize node
     * uses this on a Spaces miss; when omitted, a Spaces miss is a
     * `storage-unreachable` failure as before.
     */
    readonly canonicalDocumentFallback?: CanonicalDocumentFallbackClient;
    /**
     * Boundary the `patientMatch` node calls; production wires the
     * snapshot client per invocation (the per-call OpenEMR token comes
     * from the bearer the route received). The factory takes a
     * builder rather than a fetcher so it can compose the per-call
     * token at `stream()` time without touching the deps shape.
     */
    readonly buildFetchChartDemographics: (
        ctx: PipelineCallContext,
    ) => (pid: number) => Promise<Demographics>;
    readonly buildFetchChartSnapshot: (
        ctx: PipelineCallContext,
    ) => (pid: number) => Promise<ChartSnapshot>;
    readonly transientPrefix: string;
    readonly artifactIdGenerator: () => string;
    readonly logger: Logger;
    /**
     * Optional override for the bbox-snap pipeline. Production wires
     * the default Tesseract-backed snapper unless this is supplied;
     * tests can pass a no-op snapper to keep Vitest deterministic.
     */
    readonly bboxSnapper?: BboxSnapperLike;
}

/**
 * Build a production `PipelineRunner`. Each `stream()` call composes a
 * fresh `PipelineDeps` (cheap — just object literals, no I/O), compiles
 * the graph, and returns the LangGraph multi-mode stream. The route's
 * `for await` consumes it; nothing here outlives a single invocation.
 */
export const buildProductionPipelineRunner = (deps: ProductionPipelineDeps): PipelineRunner => {
    return {
        stream: async (input: PipelineState, ctx: PipelineCallContext, config) => {
            const persistDeps: PipelineDeps['persist'] = {
                artifactStore: deps.artifactStore,
                openemrSpaces: deps.openemrSpaces,
                documentReferenceClient: deps.documentReferenceClient,
                logger: deps.logger,
                artifactIdGenerator: deps.artifactIdGenerator,
                canonicalExt: ctx.canonicalExt,
                openemrToken: ctx.openemrToken,
                openemrSiteId: ctx.openemrSiteId,
                ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
            };
            const pipelineDeps: PipelineDeps = {
                rasterize: {
                    openemrSpaces: deps.openemrSpaces,
                    agentSpaces: deps.agentSpaces,
                    rasterizer: deps.rasterizer,
                    transientPrefix: deps.transientPrefix,
                    logger: deps.logger,
                    canonicalExt: ctx.canonicalExt,
                    ...(deps.canonicalDocumentFallback !== undefined
                        ? {
                            canonicalFallback: {
                                client: deps.canonicalDocumentFallback,
                                token: ctx.openemrToken,
                                siteId: ctx.openemrSiteId,
                                ...(ctx.conversationId !== undefined
                                    ? { conversationId: ctx.conversationId }
                                    : {}),
                            },
                        }
                        : {}),
                },
                vision: {
                    invoker: deps.visionInvoker,
                    logger: deps.logger,
                    // Bbox-snap is ON by default. Vision models — both
                    // Anthropic and OpenAI — get rows wrong by ~half a
                    // row on dense lab tables even with a row-spanning
                    // prompt. The snap pass re-OCRs each rasterized page
                    // with Tesseract, finds the cited quote text, and
                    // rewrites the bbox to wrap the actual OCR'd row.
                    // For `vision-v3-quad` quads, the snap module
                    // collapses to the bounding rect, snaps, and writes
                    // back as a degenerate axis-aligned quad — same wire
                    // shape, accurate row alignment.
                    //
                    // Set AGENT_BBOX_SNAP=0 to disable (keeps the model's
                    // raw bboxes). Useful for A/B comparisons.
                    ...(process.env['AGENT_BBOX_SNAP'] === '0'
                        ? {}
                        : {
                              bboxSnapper:
                                  deps.bboxSnapper ??
                                  createBboxSnapper({
                                      fetchBytes: defaultFetchPageBytes,
                                      logger: deps.logger,
                                  }),
                          }),
                },
                schemaValidate: { logger: deps.logger },
                patientMatch: {
                    logger: deps.logger,
                    fetchChartDemographics: deps.buildFetchChartDemographics(ctx),
                },
                persist: persistDeps,
                emitDeltas: {
                    artifactStore: deps.artifactStore,
                    logger: deps.logger,
                    fetchChartSnapshot: deps.buildFetchChartSnapshot(ctx),
                },
                cleanup: {
                    openemrSpaces: deps.openemrSpaces,
                    transientPrefix: deps.transientPrefix,
                    logger: deps.logger,
                },
            };
            const graph = createPipelineGraph(pipelineDeps);
            return graph.stream(input, config);
        },
    };
};
