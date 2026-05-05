import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';

import {
    createDocumentEvidenceRetriever,
    type DocumentEvidenceRetrieverDeps,
} from './nodes/documentEvidenceRetriever.js';
import { format } from './nodes/format.js';
import {
    createMedicationStatementBranch,
    type MedicationStatementBranchDeps,
} from './nodes/medicationStatementBranch.js';
import { persist } from './nodes/persist.js';
import {
    createPrescriptionChangeBranch,
    type PrescriptionChangeBranchDeps,
} from './nodes/prescriptionChangeBranch.js';
import {
    createReminderBranch,
    type ReminderBranchDeps,
} from './nodes/reminderBranch.js';
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
     * §A.7 supervisor deps. Optional in Phase A so existing tests that
     * don't care about supervisor routing keep working — the default
     * supervisor mimics W1's envelope-based router (pick the
     * deterministic branch matching `envelope.followUp.type` if any,
     * otherwise pick `synthesize`). Production wires the real LLM-backed
     * `decide` via `briefingRunner`. The supervisor's manifest itself
     * (the closed enum of handoffs) is fixed regardless of which
     * `decide` is supplied.
     */
    readonly supervisor?: SupervisorDeps;
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
     * §C.1 document-evidence retriever deps. Optional — when absent,
     * the A.7 stub continues to no-op so existing tests that don't
     * exercise the retriever path keep working without wiring a Tier-2
     * store.
     */
    readonly documentEvidenceRetriever?: DocumentEvidenceRetrieverDeps;
    /**
     * §3.5: when set, the compiled graph persists state via this saver,
     * keyed by the `thread_id` the caller passes on `invoke`. Production
     * wires the LangGraph Postgres saver here; in-memory tests omit it
     * (state lives only for the duration of the call).
     */
    readonly checkpointer?: BaseCheckpointSaver;
}

/**
 * §A.7 graph wiring.
 *
 * Topology (per `W2_ARCHITECTURE.md` §"Conversational graph"):
 *
 *   START → retrieveChart → supervisor (loop)
 *           supervisor ─┬→ kickoffExtraction          → supervisor
 *                       ├→ retrieveChart              → supervisor
 *                       ├→ documentEvidenceRetriever  → supervisor
 *                       ├→ evidenceRetriever          → supervisor
 *                       ├→ prescriptionChangeBranch   → verify (W1 carry-forward)
 *                       ├→ reminderBranch             → verify (W1 carry-forward)
 *                       ├→ medicationStatementBranch  → verify (W1 carry-forward)
 *                       └→ synthesize                 → verify
 *           verify → format → persist → END
 *
 * The deterministic UC3 / 4.6.5 / 4.6.6 branches go directly to
 * `verify`, not back to the supervisor. They produce a finalized
 * `claimLedger` themselves; routing them through `synthesize` would
 * overwrite that ledger with a model-authored one. The supervisor's
 * closed-enum manifest still names them (so the model can pick them
 * when the envelope's typed `followUp` matches), but the conditional
 * edge graph treats them as terminals-before-verify.
 *
 * `kickoffExtraction`, `documentEvidenceRetriever`, and
 * `evidenceRetriever` are no-op stubs in Phase A — their nodes emit a
 * "stub invoked" trace event and return control to supervisor with no
 * state changes. Phase B and Phase C swap each stub for a real
 * implementation without touching the manifest or the wiring.
 *
 * `retrieveChart` is the deterministic seed of chart context (call
 * count 0 → full fan-out per §A.4) and a supervisor-pickable handoff
 * (call count > 0 → narrowing fetch driven by
 * `state.retrieveChartArgs.categories`). Wiring it both as a START
 * successor and as a supervisor handoff keeps the architecture's "the
 * supervisor sees chart context on iteration 1" invariant without
 * doubling the deterministic logic.
 */
/**
 * Default `decide` for graphs whose deps don't supply a supervisor —
 * mimics the W1 envelope-based router so the W1 eval suite still runs
 * end-to-end while the LLM supervisor lands. Pick the deterministic
 * branch matching `envelope.followUp.type` if any; otherwise pick
 * `synthesize`. No retriever loops, no chart re-fetches.
 *
 * Production never relies on this — `briefingRunner` always wires the
 * real Anthropic `decide`.
 */
const w1FallbackDecide: SupervisorDecide = ({ state }) => {
    const followUpType = state.envelope.followUp?.type;
    if (followUpType === 'prescription_change') {
        return Promise.resolve({
            handoff: 'prescriptionChangeBranch',
            reason: 'follow-up type prescription_change',
        });
    }
    if (followUpType === 'reminder_detail') {
        return Promise.resolve({
            handoff: 'reminderBranch',
            reason: 'follow-up type reminder_detail',
        });
    }
    if (followUpType === 'medication_statement_detail') {
        return Promise.resolve({
            handoff: 'medicationStatementBranch',
            reason: 'follow-up type medication_statement_detail',
        });
    }
    return Promise.resolve({
        handoff: 'synthesize',
        reason: 'no W2 retriever wiring; fall through to synthesize',
    });
};

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
    // still pick the corresponding branch name — the supervisor's
    // manifest is fixed by Phase A — so the no-op handler below makes
    // sure the graph compiles even when an optional branch isn't wired.
    // The supervisor's prompt steers it away from picking these for
    // non-matching follow-up types, and the unwired branch acts like a
    // stub if the supervisor still picks it.
    const prescriptionChangeNode = deps.prescriptionChange !== undefined
        ? createPrescriptionChangeBranch(deps.prescriptionChange)
        : () => Promise.resolve({});
    const reminderNode = deps.reminderDetail !== undefined
        ? createReminderBranch(deps.reminderDetail)
        : () => Promise.resolve({});
    const medicationStatementNode = deps.medicationStatementDetail !== undefined
        ? createMedicationStatementBranch(deps.medicationStatementDetail)
        : () => Promise.resolve({});
    // §C.1: real `documentEvidenceRetriever` when deps are wired; the
    // A.7 stub continues to run otherwise so existing tests that don't
    // exercise the retriever path keep working without a Tier-2 store.
    const documentEvidenceRetrieverNode = deps.documentEvidenceRetriever !== undefined
        ? createDocumentEvidenceRetriever(deps.documentEvidenceRetriever)
        : documentEvidenceRetrieverStub;

    const supervisorDeps: SupervisorDeps = deps.supervisor ?? { decide: w1FallbackDecide };
    const builder = new StateGraph(BriefingStateAnnotation)
        .addNode('retrieveChart', createRetrieveChart(deps.retrieveChart))
        .addNode('supervisor', createSupervisor(supervisorDeps))
        .addNode('kickoffExtraction', kickoffExtractionStub)
        .addNode('documentEvidenceRetriever', documentEvidenceRetrieverNode)
        .addNode('evidenceRetriever', evidenceRetrieverStub)
        .addNode('prescriptionChangeBranch', prescriptionChangeNode)
        .addNode('reminderBranch', reminderNode)
        .addNode('medicationStatementBranch', medicationStatementNode)
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
            prescriptionChangeBranch: 'prescriptionChangeBranch',
            reminderBranch: 'reminderBranch',
            medicationStatementBranch: 'medicationStatementBranch',
            synthesize: 'synthesize',
        })
        // Stubs and W2 retrievers loop back to the supervisor.
        .addEdge('kickoffExtraction', 'supervisor')
        .addEdge('documentEvidenceRetriever', 'supervisor')
        .addEdge('evidenceRetriever', 'supervisor')
        // Deterministic W1 branches go directly to verify — they produce
        // a finalized ledger; running synthesize after them would
        // overwrite it.
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
