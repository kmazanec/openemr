import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';

import { format } from './nodes/format.js';
import { loadState } from './nodes/loadState.js';
import {
    createMedicationStatementBranch,
    type MedicationStatementBranchDeps,
} from './nodes/medicationStatementBranch.js';
import { persist } from './nodes/persist.js';
import { planContext } from './nodes/planContext.js';
import {
    createPrescriptionChangeBranch,
    type PrescriptionChangeBranchDeps,
} from './nodes/prescriptionChangeBranch.js';
import {
    createReminderBranch,
    type ReminderBranchDeps,
} from './nodes/reminderBranch.js';
import { createRetrieve, type RetrieveDeps } from './nodes/retrieve.js';
import { createSynthesize, type SynthesizeDeps } from './nodes/synthesize.js';
import { createVerify, type VerifyDeps } from './nodes/verify.js';
import { BriefingStateAnnotation, type BriefingState } from './state.js';

export interface BriefingGraphDeps {
    readonly retrieve: RetrieveDeps;
    readonly synthesize: SynthesizeDeps;
    readonly verify: VerifyDeps;
    /**
     * §4.3 UC3 prescription-change branch deps. Optional so existing
     * tests that build a graph without UC3 wiring still work — when
     * absent, every follow-up routes through the synthesizer (the
     * pre-§4.3 behavior). When present, follow-ups whose typed
     * params carry `type: 'prescription_change'` route into the
     * deterministic branch and bypass the synthesizer.
     */
    readonly prescriptionChange?: PrescriptionChangeBranchDeps;
    /**
     * §4.6.5 reminder-detail branch deps. Optional — when absent,
     * `reminder_detail` follow-ups fall through to the synthesizer
     * path (which won't have anything useful to say without the
     * detail tool).
     */
    readonly reminderDetail?: ReminderBranchDeps;
    /**
     * §4.6.6 medication-statement-detail branch deps. Optional —
     * when absent, `medication_statement_detail` follow-ups fall
     * through to the synthesizer path.
     */
    readonly medicationStatementDetail?: MedicationStatementBranchDeps;
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
 * a `MedicationRequest` row that must exist in
 * `snapshot.prescriptions`.
 */
export const createBriefingGraph = (deps: BriefingGraphDeps) => {
    const prescriptionChangeWired = deps.prescriptionChange !== undefined;
    const reminderDetailWired = deps.reminderDetail !== undefined;
    const medicationStatementWired = deps.medicationStatementDetail !== undefined;

    type DeterministicBranch =
        | 'prescriptionChangeBranch'
        | 'reminderBranch'
        | 'medicationStatementBranch';
    const routeAfterRetrieve = (state: BriefingState): DeterministicBranch | 'synthesize' => {
        const followUpType = state.envelope.followUp?.type;
        if (prescriptionChangeWired && followUpType === 'prescription_change') {
            return 'prescriptionChangeBranch';
        }
        if (reminderDetailWired && followUpType === 'reminder_detail') {
            return 'reminderBranch';
        }
        if (medicationStatementWired && followUpType === 'medication_statement_detail') {
            return 'medicationStatementBranch';
        }
        return 'synthesize';
    };

    // When the matching deps slot is undefined the conditional edge
    // never picks the corresponding branch name, so the no-op handler
    // below is unreachable — present only because LangGraph requires
    // every named node to have an implementation at compile time.
    const prescriptionChangeNode = deps.prescriptionChange !== undefined
        ? createPrescriptionChangeBranch(deps.prescriptionChange)
        : () => Promise.resolve({});
    const reminderNode = deps.reminderDetail !== undefined
        ? createReminderBranch(deps.reminderDetail)
        : () => Promise.resolve({});
    const medicationStatementNode = deps.medicationStatementDetail !== undefined
        ? createMedicationStatementBranch(deps.medicationStatementDetail)
        : () => Promise.resolve({});

    const builder = new StateGraph(BriefingStateAnnotation)
        .addNode('loadState', loadState)
        .addNode('planContext', planContext)
        .addNode('retrieve', createRetrieve(deps.retrieve))
        .addNode('prescriptionChangeBranch', prescriptionChangeNode)
        .addNode('reminderBranch', reminderNode)
        .addNode('medicationStatementBranch', medicationStatementNode)
        .addNode('synthesize', createSynthesize(deps.synthesize))
        .addNode('verify', createVerify(deps.verify))
        .addNode('format', format)
        .addNode('persist', persist)
        .addEdge(START, 'loadState')
        .addEdge('loadState', 'planContext')
        .addEdge('planContext', 'retrieve')
        .addConditionalEdges('retrieve', routeAfterRetrieve, {
            prescriptionChangeBranch: 'prescriptionChangeBranch',
            reminderBranch: 'reminderBranch',
            medicationStatementBranch: 'medicationStatementBranch',
            synthesize: 'synthesize',
        })
        .addEdge('prescriptionChangeBranch', 'verify')
        .addEdge('reminderBranch', 'verify')
        .addEdge('medicationStatementBranch', 'verify')
        .addEdge('synthesize', 'verify')
        .addEdge('verify', 'format')
        .addEdge('format', 'persist')
        .addEdge('persist', END);
    return deps.checkpointer
        ? builder.compile({ checkpointer: deps.checkpointer })
        : builder.compile();
};
