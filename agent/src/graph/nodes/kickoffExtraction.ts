import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import { setRunMetadata } from '../../observability/traceMetadata.js';
import { initialPipelineState, type PipelineState } from '../../pipeline/state.js';
import type { PipelineCallContext, PipelineRunner } from '../../server/routes/extract.js';
import type { PipelineStreamEvent } from '../../server/pipelineStream.js';
import { eventForNodeUpdate } from '../../server/routes/extract.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import {
    KickoffExtractionArgsSchema,
    type KickoffExtractionArgs,
    type KickoffExtractionErrorCode,
    type KickoffExtractionResult,
} from '../types.js';

/**
 * §B.9 `kickoffExtraction` node — replaces the §A.7 no-op stub.
 *
 * The supervisor picks this handoff when the envelope carries an
 * unprocessed `document_uuid` (the panel just uploaded a doc) and the
 * conversation has no extraction artifact for it yet. The node:
 *   1. Validates `args` (the supervisor's structured-output payload)
 *      against {@link KickoffExtractionArgsSchema}.
 *   2. Calls the production {@link PipelineRunner} synchronously,
 *      threading per-call values via {@link PipelineCallContext}
 *      (token, siteId, canonicalExt, conversationId).
 *   3. Forwards each pipeline `updates` chunk through an optional
 *      `onPipelineEvent` callback so the runner can pump pipeline
 *      progress into the conversation's SSE stream — the node itself
 *      stays decoupled from any transport.
 *   4. On terminal `persisted`: appends a {@link KickoffExtractionResult}
 *      with the artifact id; on terminal `failed`: appends one with the
 *      pipeline's first error code. The supervisor's next iteration
 *      reads `state.kickoffExtractionResults` to route around a failed
 *      artifact (per `W2_ARCHITECTURE.md` §"Failure isolation").
 *
 * Args validation, pipeline runtime errors, and "pipeline produced no
 * terminal state" all surface as a `failed` result with a typed
 * `errorCode` — the node never throws past the supervisor, because a
 * thrown error inside the conversational graph would tear down the
 * whole turn (the W1 verifier / synthesizer haven't run yet). The
 * runner is the right place to surface a hard pipeline failure to the
 * clinician, and it can do so by reading the appended result.
 *
 * The `pipeline` dep is constructor-style (boot-time, shared with the
 * `/v1/agent/extract` route); `openemrToken`, `openemrSiteId`,
 * `canonicalExt`, `conversationId`, and `onPipelineEvent` are
 * per-request (set by `briefingRunner` before each turn).
 */

const logger = createLogger('graph:kickoffExtraction');

export interface KickoffExtractionDeps {
    /**
     * The same {@link PipelineRunner} the §B.8 `/v1/agent/extract`
     * route consumes. Production wires
     * `buildProductionPipelineRunner` once at boot and passes the
     * single instance into both consumers.
     */
    readonly pipeline: PipelineRunner;
    /**
     * Per-request OpenEMR bearer the persist node uses for the Tier-1
     * DocumentReference write callback. Must be the same token the
     * conversational route received — the agent does not mint
     * downstream tokens here.
     */
    readonly openemrToken: string;
    readonly openemrSiteId: string;
    /**
     * File extension of the canonical Spaces object (`pdf`, `png`,
     * `jpg`, `jpeg`, `tiff`). Defaults to `pdf` because the panel-path
     * uploads PDFs only — image-passthrough is reserved for autosweep
     * / CLI replay (those paths build their own `PipelineCallContext`
     * with the correct extension). Override via the runner if a
     * future panel-side image upload lands.
     */
    readonly canonicalExt?: string;
    /**
     * The conversation row this kickoff belongs to. Threaded into the
     * pipeline so the persist node's disclosure event records the
     * right `conversationId`.
     */
    readonly conversationId?: string;
    /**
     * Live pipeline-event sink. The runner wires this to the
     * conversation's SSE stream so the panel sees `pipeline.*.complete`
     * chips while the supervisor blocks on the call. When omitted
     * (tests), the node still consumes the LangGraph stream — the
     * pipeline's terminal state is the load-bearing signal — but
     * doesn't emit per-node events.
     */
    readonly onPipelineEvent?: (event: PipelineStreamEvent) => Promise<void> | void;
}

const DEFAULT_CANONICAL_EXT = 'pdf';

const buildResult = (
    args: KickoffExtractionArgs,
    final: PipelineState | null,
): KickoffExtractionResult => {
    if (final === null) {
        return {
            documentUuid: args.document_uuid,
            docType: args.doc_type,
            status: 'failed',
            artifactId: null,
            errorCode: 'pipeline_no_terminal_state',
        };
    }
    if (final.status === 'persisted') {
        return {
            documentUuid: args.document_uuid,
            docType: args.doc_type,
            status: 'persisted',
            artifactId: final.artifactId,
            errorCode: null,
        };
    }
    // Failed path. Pipeline error codes flow through to the node's
    // error-code surface unchanged; an empty `errors[]` on a failed
    // status is structurally impossible (every failure transition
    // appends an error) so the fallback only runs as defense in depth.
    const firstError = final.errors[0];
    const errorCode: KickoffExtractionErrorCode =
        firstError?.code ?? 'pipeline_runtime_error';
    return {
        documentUuid: args.document_uuid,
        docType: args.doc_type,
        status: 'failed',
        artifactId: final.artifactId,
        errorCode,
    };
};

const appendResult = (
    state: BriefingState,
    result: KickoffExtractionResult,
): BriefingStateUpdate => ({
    kickoffExtractionResults: [...state.kickoffExtractionResults, result],
});

export const createKickoffExtraction = (
    deps: KickoffExtractionDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        // The supervisor narrows its decision into the most-recent entry
        // of `supervisorDecisionHistory` before routing. The handoff
        // schema's `args` is loose `Record<string, unknown>` at the
        // supervisor layer (see `SupervisorDecisionSchema`); per-handoff
        // narrowing is the node's job.
        const lastDecision = state.supervisorDecisionHistory.at(-1);
        const parsedArgs = KickoffExtractionArgsSchema.safeParse(lastDecision?.args);
        if (!parsedArgs.success) {
            const errorMessage = parsedArgs.error.issues[0]?.message ?? 'invalid_args';
            logger.warn(
                {
                    issues: parsedArgs.error.issues.map((i) => ({
                        path: i.path.join('.'),
                        message: i.message,
                    })),
                },
                'kickoffExtraction received invalid args; appending failed result',
            );
            setRunMetadata({
                kickoff_extraction_event: 'invalid_args',
                kickoff_extraction_message: errorMessage,
            });
            const rawUuid = lastDecision?.args?.['document_uuid'];
            const rawDocType = lastDecision?.args?.['doc_type'];
            return appendResult(state, {
                documentUuid: typeof rawUuid === 'string' ? rawUuid : '',
                docType: rawDocType === 'intake_form' ? 'intake_form' : 'lab_pdf',
                status: 'failed',
                artifactId: null,
                errorCode: 'invalid_args',
            });
        }
        const args = parsedArgs.data;

        // Resolve canonicalExt for this pipeline call. Order of
        // precedence:
        //   1. The matching `pendingUploads` entry from the envelope
        //      (the conversational panel-upload path). This is the
        //      load-bearing case — the panel knows the upload's actual
        //      file extension and the supervisor must use it, not a
        //      stale default.
        //   2. The deps-level override (`deps.canonicalExt`), used by
        //      the autosweep / CLI ctx builders that build their own
        //      `PipelineCallContext` outside the conversational path.
        //   3. The pipeline default (`pdf`), preserved for legacy
        //      parity with pre-supervisor-driven invokers.
        const matchingPendingUpload = state.envelope.pendingUploads?.find(
            (p) => p.documentUuid === args.document_uuid,
        );
        const callContext: PipelineCallContext = {
            openemrToken: deps.openemrToken,
            openemrSiteId: deps.openemrSiteId,
            canonicalExt:
                matchingPendingUpload?.canonicalExt
                ?? deps.canonicalExt
                ?? DEFAULT_CANONICAL_EXT,
            ...(deps.conversationId !== undefined ? { conversationId: deps.conversationId } : {}),
        };
        const initialState = initialPipelineState({
            documentUuid: args.document_uuid,
            docType: args.doc_type,
            pid: state.envelope.patient.pid,
            triggerSource: 'panel',
        });

        setRunMetadata({
            kickoff_extraction_event: 'invoke',
            kickoff_extraction_doc_type: args.doc_type,
            kickoff_extraction_document_uuid: args.document_uuid,
        });

        const emit = async (event: PipelineStreamEvent): Promise<void> => {
            if (deps.onPipelineEvent !== undefined) {
                await deps.onPipelineEvent(event);
            }
        };

        await emit({
            type: 'pipeline.start',
            documentUuid: args.document_uuid,
            docType: args.doc_type,
            triggerSource: 'panel',
        });

        let finalState: PipelineState | null = null;
        try {
            const stream = await deps.pipeline.stream(initialState, callContext, {
                streamMode: ['updates', 'values'],
            });
            for await (const chunk of stream) {
                if (!Array.isArray(chunk) || chunk.length !== 2) continue;
                const [mode, payload] = chunk as [string, unknown];
                if (mode === 'updates' && payload !== null && typeof payload === 'object') {
                    for (const [nodeName, nodeReturn] of Object.entries(payload)) {
                        const event = eventForNodeUpdate(nodeName, nodeReturn);
                        if (event !== null) await emit(event);
                    }
                } else if (mode === 'values') {
                    finalState = payload as PipelineState;
                }
            }
        } catch (err: unknown) {
            logger.error(
                { err, documentUuid: args.document_uuid, docType: args.doc_type },
                'kickoffExtraction pipeline run threw — appending failed result',
            );
            await emit({
                type: 'pipeline.error',
                code: 'persist_failed',
                message: 'pipeline_runtime_error',
            });
            setRunMetadata({
                kickoff_extraction_event: 'runtime_error',
            });
            return appendResult(state, {
                documentUuid: args.document_uuid,
                docType: args.doc_type,
                status: 'failed',
                artifactId: null,
                errorCode: 'pipeline_runtime_error',
            });
        }

        const result = buildResult(args, finalState);
        if (result.status === 'failed') {
            const firstError = finalState?.errors[0];
            await emit({
                type: 'pipeline.error',
                code: firstError?.code ?? 'persist_failed',
                message: firstError?.message ?? 'pipeline_failed',
            });
        }
        await emit({
            type: 'pipeline.exit',
            status: result.status,
            artifactId: result.artifactId,
        });

        setRunMetadata({
            kickoff_extraction_event: 'complete',
            kickoff_extraction_status: result.status,
            kickoff_extraction_error_code: result.errorCode,
        });
        return appendResult(state, result);
    };

    return traceable(impl, { name: 'kickoffExtraction', run_type: 'chain' });
};
