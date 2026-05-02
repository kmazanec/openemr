import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';

import { format } from './nodes/format.js';
import { loadState } from './nodes/loadState.js';
import {
    createMedChangeBranch,
    type MedChangeBranchDeps,
} from './nodes/medChangeBranch.js';
import { persist } from './nodes/persist.js';
import { planContext } from './nodes/planContext.js';
import { createRetrieve, type RetrieveDeps } from './nodes/retrieve.js';
import { createSynthesize, type SynthesizeDeps } from './nodes/synthesize.js';
import { createVerify, type VerifyDeps } from './nodes/verify.js';
import { BriefingStateAnnotation, type BriefingState } from './state.js';

export interface BriefingGraphDeps {
    readonly retrieve: RetrieveDeps;
    readonly synthesize: SynthesizeDeps;
    readonly verify: VerifyDeps;
    /**
     * §4.3 UC3 medication-change branch deps. Optional so existing
     * tests that build a graph without UC3 wiring still work — when
     * absent, every follow-up routes through the synthesizer (the
     * pre-§4.3 behavior). When present, follow-ups whose typed
     * params carry `type: 'medication_change'` route into the
     * deterministic branch and bypass the synthesizer.
     */
    readonly medChange?: MedChangeBranchDeps;
    /**
     * §3.5: when set, the compiled graph persists state via this saver,
     * keyed by the `thread_id` the caller passes on `invoke`. Production
     * wires the LangGraph Postgres saver here; in-memory tests omit it
     * (state lives only for the duration of the call).
     */
    readonly checkpointer?: BaseCheckpointSaver;
}

/**
 * §3.2 graph wiring. Mostly linear; §4.3 adds one conditional edge
 * after `retrieve` so UC3 follow-ups bypass the synthesizer for a
 * deterministic provenance lookup. The retrieve and synthesize deps
 * are injected per-graph so the bearer token (Retrieve) and the LLM
 * client (Synthesize) can be configured per request without baking
 * them into module-level globals.
 *
 * The branch still goes through `retrieve` first because the verifier
 * needs the snapshot to resolve source references — UC3's claim cites
 * a `MedicationRequest` row that must exist in `snapshot.medications`.
 */
export const createBriefingGraph = (deps: BriefingGraphDeps) => {
    const medChangeWired = deps.medChange !== undefined;
    const routeAfterRetrieve = (state: BriefingState): 'medChangeBranch' | 'synthesize' =>
        medChangeWired && state.envelope.followUp?.type === 'medication_change'
            ? 'medChangeBranch'
            : 'synthesize';

    // When deps.medChange is undefined the conditional edge never picks
    // 'medChangeBranch', so the no-op handler below is unreachable —
    // present only because LangGraph requires every named node to have
    // an implementation at compile time.
    const medChangeNode = deps.medChange !== undefined
        ? createMedChangeBranch(deps.medChange)
        : () => Promise.resolve({});

    const builder = new StateGraph(BriefingStateAnnotation)
        .addNode('loadState', loadState)
        .addNode('planContext', planContext)
        .addNode('retrieve', createRetrieve(deps.retrieve))
        .addNode('medChangeBranch', medChangeNode)
        .addNode('synthesize', createSynthesize(deps.synthesize))
        .addNode('verify', createVerify(deps.verify))
        .addNode('format', format)
        .addNode('persist', persist)
        .addEdge(START, 'loadState')
        .addEdge('loadState', 'planContext')
        .addEdge('planContext', 'retrieve')
        .addConditionalEdges('retrieve', routeAfterRetrieve, {
            medChangeBranch: 'medChangeBranch',
            synthesize: 'synthesize',
        })
        .addEdge('medChangeBranch', 'verify')
        .addEdge('synthesize', 'verify')
        .addEdge('verify', 'format')
        .addEdge('format', 'persist')
        .addEdge('persist', END);
    return deps.checkpointer
        ? builder.compile({ checkpointer: deps.checkpointer })
        : builder.compile();
};
