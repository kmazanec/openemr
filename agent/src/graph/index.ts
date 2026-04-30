import { END, START, StateGraph } from '@langchain/langgraph';

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
}

/**
 * §3.2 graph wiring. Linear LangGraph for UC1 — every node runs once
 * per invocation. The retrieve and synthesize deps are injected per-graph
 * so the bearer token (Retrieve) and the LLM client (Synthesize) can be
 * configured per request without baking them into module-level globals.
 *
 * The graph compiles without a checkpointer here. Production wiring
 * (Phase 3.5) supplies the LangGraph Postgres checkpointer at
 * `compile({ checkpointer })` time so conversation state durably
 * resumes across requests.
 */
export const createBriefingGraph = (deps: BriefingGraphDeps) => {
    return new StateGraph(BriefingStateAnnotation)
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
        .addEdge('persist', END)
        .compile();
};
