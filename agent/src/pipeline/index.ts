/**
 * §B.3 / §B.4 / §B.5 / §B.6 / §B.7 Pipeline graph wiring.
 *
 * The ingestion pipeline is a separate compiled LangGraph app
 * (W2_ARCHITECTURE.md §"Pipeline as a compiled LangGraph app"). It is
 * built once at agent boot and invoked synchronously per extraction.
 *
 * Wired: `rasterize` (B.3) → `vision` (B.4) → `schemaValidate` (B.5) →
 * `patientMatch` (B.6) → `persist` (B.7) → `emitDeltas` (B.7) →
 * `cleanup` (B.7) → END.
 *
 * The `cleanup` node also runs on every short-circuit failure path so
 * a doc that gets refused (cost cap, schema invalid, patient mismatch,
 * persist failure) still wipes its transient PNGs from Spaces; the
 * 24h lifecycle policy is the fallback.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { LastValue } from '@langchain/langgraph/channels';

import { cleanup, type CleanupDeps } from './nodes/cleanup.js';
import { emitDeltas, type EmitDeltasDeps } from './nodes/emitDeltas.js';
import { patientMatch, type PatientMatchDeps } from './nodes/patientMatch.js';
import { persist, type PersistDeps } from './nodes/persist.js';
import { rasterize, type RasterizeDeps } from './nodes/rasterize.js';
import { schemaValidate, type SchemaValidateDeps } from './nodes/schemaValidate.js';
import { vision, type VisionDeps } from './nodes/vision.js';
import { type DocumentType } from '../state/extractionArtifacts.js';
import {
    type ConfidenceSignal,
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
    documentText: lastValueChannel<string | null>(() => null),
    schema: lastValueChannel<unknown>(() => null),
    artifactId: lastValueChannel<string | null>(() => null),
    confidenceSignal: lastValueChannel<ConfidenceSignal | null>(() => null),
    status: lastValueChannel<PipelineStatus>(() => 'pending'),
    errors: lastValueChannel<readonly PipelineError[]>(() => []),
});

export interface PipelineDeps {
    readonly rasterize: RasterizeDeps;
    readonly vision: VisionDeps;
    readonly schemaValidate: SchemaValidateDeps;
    readonly patientMatch: PatientMatchDeps;
    readonly persist: PersistDeps;
    readonly emitDeltas: EmitDeltasDeps;
    readonly cleanup: CleanupDeps;
}

/**
 * Failure-isolation router: if the upstream node set
 * `status='failed'`, short-circuit straight to `cleanup` so transient
 * PNGs are still wiped before EXIT. The cleanup node preserves the
 * upstream status so the EXIT-edge state still represents the real
 * outcome.
 */
const routeOrCleanup =
    (next: string) =>
    (state: PipelineState): string =>
        state.status === 'failed' ? 'cleanup' : next;

export const createPipelineGraph = (deps: PipelineDeps) => {
    const builder = new StateGraph(PipelineStateAnnotation)
        .addNode('rasterize', (state: PipelineState) => rasterize(state, deps.rasterize))
        .addNode('vision', (state: PipelineState) => vision(state, deps.vision))
        .addNode('schemaValidate', (state: PipelineState) => schemaValidate(state, deps.schemaValidate))
        .addNode('patientMatch', (state: PipelineState) => patientMatch(state, deps.patientMatch))
        .addNode('persist', (state: PipelineState) => persist(state, deps.persist))
        .addNode('emitDeltas', (state: PipelineState) => emitDeltas(state, deps.emitDeltas))
        .addNode('cleanup', (state: PipelineState) => cleanup(state, deps.cleanup))
        .addEdge(START, 'rasterize')
        .addConditionalEdges('rasterize', routeOrCleanup('vision'), {
            vision: 'vision',
            cleanup: 'cleanup',
        })
        .addConditionalEdges('vision', routeOrCleanup('schemaValidate'), {
            schemaValidate: 'schemaValidate',
            cleanup: 'cleanup',
        })
        .addConditionalEdges('schemaValidate', routeOrCleanup('patientMatch'), {
            patientMatch: 'patientMatch',
            cleanup: 'cleanup',
        })
        .addConditionalEdges('patientMatch', routeOrCleanup('persist'), {
            persist: 'persist',
            cleanup: 'cleanup',
        })
        .addConditionalEdges('persist', routeOrCleanup('emitDeltas'), {
            emitDeltas: 'emitDeltas',
            cleanup: 'cleanup',
        })
        .addEdge('emitDeltas', 'cleanup')
        .addEdge('cleanup', END);
    return builder.compile();
};
