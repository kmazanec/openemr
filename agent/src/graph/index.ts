import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';

import { format } from './nodes/format.js';
import { loadState } from './nodes/loadState.js';
import { persist } from './nodes/persist.js';
import { planContext } from './nodes/planContext.js';
import { createRetrieve, type RetrieveDeps } from './nodes/retrieve.js';
import { createSynthesize, type SynthesizeDeps } from './nodes/synthesize.js';
import { createVerify, type VerifyDeps } from './nodes/verify.js';
import { BriefingStateAnnotation } from './state.js';

export interface BriefingGraphDeps {
    readonly retrieve: RetrieveDeps;
    readonly synthesize: SynthesizeDeps;
    readonly verify: VerifyDeps;
    /**
     * §3.5: when set, the compiled graph persists state via this saver,
     * keyed by the `thread_id` the caller passes on `invoke`. Production
     * wires the LangGraph Postgres saver here; in-memory tests omit it
     * (state lives only for the duration of the call).
     */
    readonly checkpointer?: BaseCheckpointSaver;
}

/**
 * §3.2 graph wiring. Linear LangGraph for UC1 — every node runs once
 * per invocation. The retrieve and synthesize deps are injected per-graph
 * so the bearer token (Retrieve) and the LLM client (Synthesize) can be
 * configured per request without baking them into module-level globals.
 */
export const createBriefingGraph = (deps: BriefingGraphDeps) => {
    const builder = new StateGraph(BriefingStateAnnotation)
        .addNode('loadState', loadState)
        .addNode('planContext', planContext)
        .addNode('retrieve', createRetrieve(deps.retrieve))
        .addNode('synthesize', createSynthesize(deps.synthesize))
        .addNode('verify', createVerify(deps.verify))
        .addNode('format', format)
        .addNode('persist', persist)
        .addEdge(START, 'loadState')
        .addEdge('loadState', 'planContext')
        .addEdge('planContext', 'retrieve')
        .addEdge('retrieve', 'synthesize')
        .addEdge('synthesize', 'verify')
        .addEdge('verify', 'format')
        .addEdge('format', 'persist')
        .addEdge('persist', END);
    return deps.checkpointer
        ? builder.compile({ checkpointer: deps.checkpointer })
        : builder.compile();
};
