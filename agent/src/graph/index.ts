import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';

import {
    createDocumentEvidenceRetriever,
    type DocumentEvidenceRetrieverDeps,
} from './nodes/documentEvidenceRetriever.js';
import {
    createEvidenceRetriever,
    type EvidenceRetrieverDeps,
} from './nodes/evidenceRetriever.js';
import { format } from './nodes/format.js';
import {
    createKickoffExtraction,
    type KickoffExtractionDeps,
} from './nodes/kickoffExtraction.js';
import { persist } from './nodes/persist.js';
import { createRetrieveChart, type RetrieveChartDeps } from './nodes/retrieveChart.js';
import {
    documentEvidenceRetrieverStub,
    evidenceRetrieverStub,
    kickoffExtractionStub,
} from './nodes/stubs.js';
import {
    createSupervisor,
    type SupervisorDecide,
    type SupervisorDeps,
} from './nodes/supervisor.js';
import { createSynthesize, type SynthesizeDeps } from './nodes/synthesize.js';
import { createVerify, type VerifyDeps } from './nodes/verify.js';
import { BriefingStateAnnotation, type BriefingState } from './state.js';
import type { SupervisorHandoff } from './types.js';

export interface BriefingGraphDeps {
    readonly retrieveChart: RetrieveChartDeps;
    /**
     * Supervisor deps. Optional so tests that don't care about supervisor
     * routing keep working — the fallback `decide` always picks
     * `synthesize`. Production wires the real LLM-backed `decide` via
     * `briefingRunner`. The supervisor's manifest (the closed enum of
     * handoffs) is fixed regardless of which `decide` is supplied.
     */
    readonly supervisor?: SupervisorDeps;
    readonly synthesize: SynthesizeDeps;
    readonly verify: VerifyDeps;
    /**
     * Document-evidence retriever deps. Optional — when absent, the
     * stub continues to no-op so existing tests that don't exercise
     * the retriever path keep working without wiring a Tier-2 store.
     */
    readonly documentEvidenceRetriever?: DocumentEvidenceRetrieverDeps;
    /**
     * Evidence retriever deps (Pinecone hybrid + Cohere rerank).
     * Optional — when absent, the stub keeps running so the graph
     * compiles without Pinecone/OpenAI/Cohere credentials. Present only
     * when the runner has fitted BM25 stats from the corpus and built
     * the hybrid + rerank clients (see `briefingRunner`).
     */
    readonly evidenceRetriever?: EvidenceRetrieverDeps;
    /**
     * kickoffExtraction deps. Optional — when absent, the stub continues
     * to no-op so existing tests that don't exercise the panel-upload
     * path keep working without standing up a `PipelineRunner`.
     * Production wires this in `briefingRunner` per request, threading
     * the per-turn token / siteId / conversationId plus the SSE
     * pipeline-event sink.
     */
    readonly kickoffExtraction?: KickoffExtractionDeps;
    /**
     * Test-only node override for `kickoffExtraction`. Used by the
     * conversational-graph eval target to inject a fake-success kickoff
     * stub: it appends a `persisted` `KickoffExtractionResult` to state
     * without standing up a real `PipelineRunner`. Production must
     * never set this — the regular `kickoffExtraction` deps are the
     * supported path. When both are set, the override wins (so a test
     * can ignore the real deps shape entirely). The two-knob design
     * keeps the production deps slot as the canonical surface while
     * giving tests a 5-line escape hatch for the supervisor-routing
     * cases that need a "kickoff already happened" signal in state.
     */
    readonly kickoffExtractionNodeOverride?: (
        state: BriefingState,
    ) => Promise<Partial<BriefingState>>;
    /**
     * When set, the compiled graph persists state via this saver, keyed
     * by the `thread_id` the caller passes on `invoke`. Production wires
     * the LangGraph Postgres saver here; in-memory tests omit it (state
     * lives only for the duration of the call).
     */
    readonly checkpointer?: BaseCheckpointSaver;
}

/**
 * Graph wiring.
 *
 * Topology:
 *
 *   START → retrieveChart → supervisor (loop)
 *           supervisor ─┬→ kickoffExtraction          → supervisor
 *                       ├→ retrieveChart              → supervisor
 *                       ├→ documentEvidenceRetriever  → supervisor
 *                       ├→ evidenceRetriever          → supervisor
 *                       └→ synthesize                 → verify
 *           verify → format → persist → END
 *
 * `kickoffExtraction`, `documentEvidenceRetriever`, and
 * `evidenceRetriever` each have real implementations — each deps slot is
 * optional so the graph still compiles for tests that don't supply the
 * upstream pipeline runner / store / clients (the matching stub then
 * runs and returns control to the supervisor with no state changes).
 *
 * `retrieveChart` is the deterministic seed of chart context (call
 * count 0 → full fan-out) and a supervisor-pickable handoff (call count
 * > 0 → narrowing fetch driven by `state.retrieveChartArgs.categories`).
 * Wiring it both as a START successor and as a supervisor handoff keeps
 * the "supervisor sees chart context on iteration 1" invariant without
 * doubling the deterministic logic.
 */
/**
 * Fallback `decide` for graphs whose deps don't supply a supervisor.
 * Always picks `synthesize` — used by tests that don't care about
 * routing. Production wires the real Anthropic `decide` in
 * `briefingRunner`.
 */
const defaultSupervisorDecide: SupervisorDecide = () =>
    Promise.resolve({
        handoff: 'synthesize',
        reason: 'no supervisor wiring; fall through to synthesize',
        narration: 'Drafting your briefing.',
    });

export const createBriefingGraph = (deps: BriefingGraphDeps) => {
    const routeFromSupervisor = (state: BriefingState): SupervisorHandoff => {
        const last = state.supervisorDecisionHistory.at(-1);
        if (last === undefined) {
            // Defensive: the supervisor always appends a decision before
            // returning. If this ever fires it's an internal invariant
            // bug, not a user-input issue.
            throw new Error('supervisor returned without appending a decision');
        }
        return last.handoff;
    };

    // When the matching deps slot is undefined the conditional edge can
    // still pick the corresponding handoff name — the supervisor's
    // manifest is fixed — so the stubs below make sure the graph compiles
    // even when an optional retriever isn't wired.
    const documentEvidenceRetrieverNode = deps.documentEvidenceRetriever !== undefined
        ? createDocumentEvidenceRetriever(deps.documentEvidenceRetriever)
        : documentEvidenceRetrieverStub;
    const evidenceRetrieverNode = deps.evidenceRetriever !== undefined
        ? createEvidenceRetriever(deps.evidenceRetriever)
        : evidenceRetrieverStub;
    const kickoffExtractionNode =
        deps.kickoffExtractionNodeOverride
        ?? (deps.kickoffExtraction !== undefined
            ? createKickoffExtraction(deps.kickoffExtraction)
            : kickoffExtractionStub);

    const supervisorDeps: SupervisorDeps = deps.supervisor ?? { decide: defaultSupervisorDecide };
    const builder = new StateGraph(BriefingStateAnnotation)
        .addNode('retrieveChart', createRetrieveChart(deps.retrieveChart))
        .addNode('supervisor', createSupervisor(supervisorDeps))
        .addNode('kickoffExtraction', kickoffExtractionNode)
        .addNode('documentEvidenceRetriever', documentEvidenceRetrieverNode)
        .addNode('evidenceRetriever', evidenceRetrieverNode)
        .addNode('synthesize', createSynthesize(deps.synthesize))
        .addNode('verify', createVerify(deps.verify))
        .addNode('format', format)
        .addNode('persist', persist)
        .addEdge(START, 'retrieveChart')
        .addEdge('retrieveChart', 'supervisor')
        .addConditionalEdges('supervisor', routeFromSupervisor, {
            kickoffExtraction: 'kickoffExtraction',
            retrieveChart: 'retrieveChart',
            documentEvidenceRetriever: 'documentEvidenceRetriever',
            evidenceRetriever: 'evidenceRetriever',
            synthesize: 'synthesize',
        })
        // Retrievers loop back to the supervisor for the next decision.
        .addEdge('kickoffExtraction', 'supervisor')
        .addEdge('documentEvidenceRetriever', 'supervisor')
        .addEdge('evidenceRetriever', 'supervisor')
        .addEdge('synthesize', 'verify')
        .addEdge('verify', 'format')
        .addEdge('format', 'persist')
        .addEdge('persist', END);
    return deps.checkpointer
        ? builder.compile({ checkpointer: deps.checkpointer })
        : builder.compile();
};
