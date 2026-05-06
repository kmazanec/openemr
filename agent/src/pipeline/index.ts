/**
 * §B.3 Pipeline graph wiring.
 *
 * The ingestion pipeline is a separate compiled LangGraph app
 * (W2_ARCHITECTURE.md §"Pipeline as a compiled LangGraph app"). It is
 * built once at agent boot and invoked synchronously per extraction.
 *
 * This subphase wires only the first node — `rasterize`. Subsequent
 * subphases (B.4 `vision`, B.5 `schemaValidate`, B.6 `patientMatch`,
 * B.7 `persist` + `emitDeltas`) extend the same graph factory.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

import { rasterize, type RasterizeDeps } from './nodes/rasterize.js';
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
}

export const createPipelineGraph = (deps: PipelineDeps) => {
    const builder = new StateGraph(PipelineStateAnnotation)
        .addNode('rasterize', (state: PipelineState) => rasterize(state, deps.rasterize))
        .addEdge(START, 'rasterize')
        .addEdge('rasterize', END);
    return builder.compile();
};
