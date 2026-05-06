/**
 * §B.3 / §B.4 / §B.5 Pipeline graph wiring.
 *
 * The ingestion pipeline is a separate compiled LangGraph app
 * (W2_ARCHITECTURE.md §"Pipeline as a compiled LangGraph app"). It is
 * built once at agent boot and invoked synchronously per extraction.
 *
 * Currently wired: `rasterize` (B.3) → `vision` (B.4) →
 * `schemaValidate` (B.5). Subsequent subphases (B.6 `patientMatch`,
 * B.7 `persist` + `emitDeltas`) extend the same graph factory.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

import { rasterize, type RasterizeDeps } from './nodes/rasterize.js';
import { schemaValidate, type SchemaValidateDeps } from './nodes/schemaValidate.js';
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
    readonly schemaValidate: SchemaValidateDeps;
}

/**
 * Failure-isolation router used between every consecutive node pair:
 * if the upstream node set `status='failed'`, short-circuit to END so
 * downstream nodes don't run on poisoned state. The successor name is
 * passed in so each edge keeps its own (failed → END, ok → next) shape.
 */
const routeOrFail =
    (next: string) =>
    (state: PipelineState): string =>
        state.status === 'failed' ? END : next;

export const createPipelineGraph = (deps: PipelineDeps) => {
    const builder = new StateGraph(PipelineStateAnnotation)
        .addNode('rasterize', (state: PipelineState) => rasterize(state, deps.rasterize))
        .addNode('vision', (state: PipelineState) => vision(state, deps.vision))
        .addNode('schemaValidate', (state: PipelineState) => schemaValidate(state, deps.schemaValidate))
        .addEdge(START, 'rasterize')
        .addConditionalEdges('rasterize', routeOrFail('vision'), {
            vision: 'vision',
            [END]: END,
        })
        .addConditionalEdges('vision', routeOrFail('schemaValidate'), {
            schemaValidate: 'schemaValidate',
            [END]: END,
        })
        .addEdge('schemaValidate', END);
    return builder.compile();
};
