/**
 * §B.8 `/v1/agent/extract` route — invokes the ingestion pipeline
 * synchronously from path A (panel upload during a conversation) and
 * pumps progress events back to the caller as SSE.
 *
 * The OpenEMR proxy (`AgentProxyController` via `agent.php` with
 * `action=extract`) mints an agent JWT, posts the request body to this
 * route, and pipes the SSE response back to the browser. The agent's
 * existing bearer middleware already validated the JWT before the
 * handler runs.
 *
 * The route is the third invoker of the pipeline (path A — see
 * `W2_ARCHITECTURE.md` §"Three invokers, one pipeline"). Paths B
 * (DocumentUploadedEvent listener) and C (CLI replay) construct
 * `pipelineGraph` separately; this route is the only one that streams
 * progress over SSE.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { getPrincipal, getRawToken } from '../../auth/middleware.js';
import { createLogger } from '../../observability/logger.js';
import {
    buildIdentityTags,
    setRunMetadata,
} from '../../observability/traceMetadata.js';
import { initialPipelineState, type PipelineState } from '../../pipeline/state.js';
import {
    encodePipelineEvent,
    type PipelineStreamEvent,
} from '../pipelineStream.js';

/**
 * Per-call inputs the production pipeline needs that aren't carried on
 * `PipelineState`. The route extracts these from the bearer token and
 * the inbound envelope; the production factory threads them into a
 * freshly-compiled graph (`PersistDeps.openemrToken` / `canonicalExt`
 * are per-invocation, not boot-time, so the graph is rebuilt per
 * invoke). Tests skip this entirely by stubbing `PipelineRunner.stream`.
 */
export interface PipelineCallContext {
    readonly openemrToken: string;
    readonly openemrSiteId: string;
    readonly canonicalExt: string;
    readonly conversationId?: string;
}

/**
 * The compiled pipeline graph exposes `.stream(input, config)` returning an
 * async iterable of `[mode, payload]` tuples (LangGraph multi-mode
 * streaming). We type only the surface this route consumes; the full graph
 * shape lives in `pipeline/index.ts`.
 */
export interface PipelineRunner {
    readonly stream: (
        input: PipelineState,
        ctx: PipelineCallContext,
        config?: Readonly<Record<string, unknown>>,
    ) => Promise<AsyncIterable<unknown>>;
}

const extractRequestSchema = z.object({
    pid: z.number().int().positive(),
    document_uuid: z.string().min(1).max(200),
    doc_type: z.union([z.literal('lab_pdf'), z.literal('intake_form')]),
    trigger_source: z.union([
        z.literal('panel'),
        z.literal('autosweep'),
        z.literal('cli'),
    ]),
    /**
     * File extension of the canonical Spaces object (`pdf`, `png`,
     * `jpg`, `jpeg`, `tiff`). The pre-upload step records this when
     * the bytes land; the trigger envelope carries it forward so the
     * `rasterize` and `persist` nodes know how to address the canonical
     * key. Defaults to `pdf` — the panel-path uploads PDFs only;
     * image-passthrough is reserved for autosweep / CLI replay.
     */
    canonical_ext: z.string().min(1).max(8).default('pdf'),
    conversation_id: z.string().min(1).max(200).optional(),
});

export interface ExtractRouteDeps {
    readonly pipeline: PipelineRunner;
}

/**
 * Translate LangGraph `updates`-mode chunks (one chunk per node
 * completion) into the user-visible `pipeline.*.complete` events. Nodes
 * that aren't worth surfacing to the panel (cleanup, schemaValidate,
 * patientMatch) are skipped here.
 *
 * Returned events appear in the SSE stream in the order the nodes
 * complete; the `exit` and `error` events are emitted by the route
 * handler itself based on the terminal `values`-mode state.
 */
export const eventForNodeUpdate = (
    nodeName: string,
    nodeReturn: unknown,
): PipelineStreamEvent | null => {
    if (nodeReturn === null || typeof nodeReturn !== 'object') return null;
    const ret = nodeReturn as Record<string, unknown>;
    switch (nodeName) {
        case 'rasterize': {
            const pages = Array.isArray(ret['pages']) ? ret['pages'] : null;
            if (pages === null) return null;
            return { type: 'pipeline.rasterize.complete', pageCount: pages.length };
        }
        case 'vision':
            return { type: 'pipeline.vision.complete' };
        case 'persist': {
            const artifactId = typeof ret['artifactId'] === 'string' ? ret['artifactId'] : null;
            if (artifactId === null) return null;
            return { type: 'pipeline.persist.complete', artifactId };
        }
        default:
            return null;
    }
};

export const createExtractHandler = (deps: ExtractRouteDeps) => {
    const logger = createLogger('extract-route');
    return async (c: Context): Promise<Response> => {
        const principal = getPrincipal(c);
        const token = getRawToken(c);
        const rawBody: unknown = await c.req.json().catch(() => null);
        const parsed = extractRequestSchema.safeParse(rawBody);

        return streamSSE(c, async (stream) => {
            const writeEvent = async (event: PipelineStreamEvent): Promise<void> => {
                await stream.write(encodePipelineEvent(event));
            };

            if (!parsed.success) {
                await writeEvent({
                    type: 'pipeline.error',
                    code: 'schema_invalid',
                    message: 'invalid_envelope',
                });
                return;
            }

            const {
                pid,
                document_uuid: documentUuid,
                doc_type: docType,
                trigger_source: triggerSource,
                canonical_ext: canonicalExt,
                conversation_id: conversationId,
            } = parsed.data;
            const callContext: PipelineCallContext = {
                openemrToken: token,
                openemrSiteId: principal.siteId,
                canonicalExt,
                ...(conversationId !== undefined ? { conversationId } : {}),
            };
            const tags = buildIdentityTags({
                clinicianId: principal.sub,
                patientId: String(pid),
            });
            // Per-pipeline trace metadata. The vision node already
            // records token / cost / confidence-distribution metadata
            // (§B.4); this is the request-shaped metadata the panel-
            // path needs (trigger_source, doc_type, page_count later
            // overwritten by rasterize). Emitting from the route
            // means a CLI invoker sets a different `trigger_source`
            // without this route running.
            setRunMetadata({
                site_id: principal.siteId,
                trigger_source: triggerSource,
                doc_type: docType,
                document_uuid: documentUuid,
            });

            await writeEvent({
                type: 'pipeline.start',
                documentUuid,
                docType,
                triggerSource,
            });

            const initialState = initialPipelineState({
                documentUuid,
                docType,
                pid,
                triggerSource,
            });

            let finalState: PipelineState | null = null;
            try {
                const pipelineStream = await deps.pipeline.stream(initialState, callContext, {
                    tags: [`clinician:${tags.clinicianHash}`, `patient:${tags.patientHash}`],
                    metadata: {
                        site_id: principal.siteId,
                        trigger_source: triggerSource,
                        doc_type: docType,
                        document_uuid: documentUuid,
                    },
                    streamMode: ['updates', 'values'],
                });

                for await (const chunk of pipelineStream) {
                    if (!Array.isArray(chunk) || chunk.length !== 2) continue;
                    const [mode, payload] = chunk as [string, unknown];
                    if (mode === 'updates' && payload !== null && typeof payload === 'object') {
                        for (const [nodeName, nodeReturn] of Object.entries(payload)) {
                            const event = eventForNodeUpdate(nodeName, nodeReturn);
                            if (event !== null) await writeEvent(event);
                        }
                    } else if (mode === 'values') {
                        finalState = payload as PipelineState;
                    }
                }
            } catch (err) {
                logger.error(
                    { err, documentUuid, docType },
                    'pipeline run threw — emitting pipeline.error',
                );
                await writeEvent({
                    type: 'pipeline.error',
                    code: 'persist_failed',
                    message: 'pipeline_runtime_error',
                });
                return;
            }

            if (finalState === null) {
                logger.error(
                    { documentUuid, docType },
                    'pipeline produced no values chunk — emitting pipeline.error',
                );
                await writeEvent({
                    type: 'pipeline.error',
                    code: 'persist_failed',
                    message: 'pipeline_no_terminal_state',
                });
                return;
            }

            if (finalState.status === 'failed') {
                const firstError = finalState.errors[0];
                await writeEvent({
                    type: 'pipeline.error',
                    code: firstError?.code ?? 'persist_failed',
                    message: firstError?.message ?? 'pipeline_failed',
                });
                await writeEvent({
                    type: 'pipeline.exit',
                    status: 'failed',
                    artifactId: finalState.artifactId,
                });
                return;
            }

            await writeEvent({
                type: 'pipeline.exit',
                status: 'persisted',
                artifactId: finalState.artifactId,
            });
        });
    };
};
