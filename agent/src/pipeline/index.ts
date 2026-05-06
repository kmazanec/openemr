/**
 * §B.3 / §B.4 Pipeline graph wiring.
 *
 * The ingestion pipeline is a separate compiled LangGraph app
 * (W2_ARCHITECTURE.md §"Pipeline as a compiled LangGraph app"). It is
 * built once at agent boot and invoked synchronously per extraction.
 *
 * Currently wired: `rasterize` (B.3) → `vision` (B.4). Subsequent
 * subphases (B.5 `schemaValidate`, B.6 `patientMatch`, B.7 `persist`
 * + `emitDeltas`) extend the same graph factory.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

import { rasterize, type RasterizeDeps } from './nodes/rasterize.js';
import { vision, type VisionDeps } from './nodes/vision.js';
import { type DocumentType } from '../state/extractionArtifacts.js';
import {
    type PageImage,
    type PipelineError,
    type PipelineState,
    type PipelineStatus,
    type TriggerSource,
} from './state.js';

const lastValueChannel =
    <T>(factory: () => T): (() => LastValue<T>) =>
    () =>
        new LastValue<T>(factory);

/**
 * Pipeline state annotation. Mirrors the convention from
 * `agent/src/graph/state.ts`: every slot is `LastValue<T>` so node
 * returns are exactly `Partial<PipelineState>` without
 * `OverwriteValue<T>` leakage.
 */
export const PipelineStateAnnotation = Annotation.Root({
    documentUuid: Annotation<string>,
    docType: Annotation<DocumentType>,
    pid: Annotation<number>,
    triggerSource: Annotation<TriggerSource>,
    pages: lastValueChannel<readonly PageImage[]>(() => []),
    schema: lastValueChannel<unknown>(() => null),
    artifactId: lastValueChannel<string | null>(() => null),
    status: lastValueChannel<PipelineStatus>(() => 'pending'),
    errors: lastValueChannel<readonly PipelineError[]>(() => []),
});

export interface PipelineDeps {
    readonly rasterize: RasterizeDeps;
    readonly vision: VisionDeps;
}

/**
 * Routes the post-rasterize edge: if rasterize set status to 'failed'
 * (cost cap, corrupted PDF, storage unreachable, …), skip vision and
 * short-circuit to END. Otherwise continue to vision. Mirrors the
 * `Failure isolation` rule in `W2_ARCHITECTURE.md` — a failed pipeline
 * ends as a structured-error artifact, downstream nodes don't run on
 * top of failed state.
 */
const routeAfterRasterize = (state: PipelineState): 'vision' | typeof END =>
    state.status === 'failed' ? END : 'vision';

export const createPipelineGraph = (deps: PipelineDeps) => {
    const builder = new StateGraph(PipelineStateAnnotation)
        .addNode('rasterize', (state: PipelineState) => rasterize(state, deps.rasterize))
        .addNode('vision', (state: PipelineState) => vision(state, deps.vision))
        .addEdge(START, 'rasterize')
        .addConditionalEdges('rasterize', routeAfterRasterize, {
            vision: 'vision',
            [END]: END,
        })
        .addEdge('vision', END);
    return builder.compile();
};
