import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { traceable } from 'langsmith/traceable';

import type { Counters } from '../../observability/counters.js';
import { createNoopCounters } from '../../observability/counters.js';
import { createLogger } from '../../observability/logger.js';
import {
    costForUsage,
    scrubLlmTextForTrace,
    setRunMetadata,
} from '../../observability/traceMetadata.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import { structuredOutputParseError } from './structuredOutputError.js';
import {
    DocumentEvidenceArgsSchema,
    EvidenceArgsSchema,
    RETRIEVE_CHART_CATEGORIES,
    SupervisorDecisionSchema,
    type DocumentEvidenceArgs,
    type EvidenceArgs,
    type RetrieveChartArgs,
    type SupervisorDecision,
    type SupervisorHandoff,
} from '../types.js';

/**
 * §A.7 LLM-driven supervisor node. Replaces W1's deterministic
 * conditional-edge router with a model call that picks from a closed
 * enumeration of handoffs and returns a Zod-coerced
 * `{handoff, reason, args?}`.
 *
 * Per `W2_ARCHITECTURE.md` §"Supervisor loop":
 *  - The model picks a handoff; it cannot invent one.
 *  - `reason` is non-empty by Zod contract — required rationale logged
 *    on every iteration.
 *  - The iteration cap (10) is structural, not a heuristic: at the cap,
 *    the supervisor forces `synthesize` with `capHit: true` so even
 *    degenerate sequences terminate.
 *  - Cycle detection emits a `degenerate-loop` warning but does not
 *    terminate — the cap absorbs pathological loops.
 *
 * The LLM call is injected via the `decide` seam so the per-MR Vitest
 * gate stays deterministic and cost-free; production wiring builds the
 * real Anthropic client through `createAnthropicSupervisorDecide`.
 */

/** Iteration cap. `W2_ARCHITECTURE.md` §"Iteration cap: 10" — eval-pinned. */
export const SUPERVISOR_ITERATION_CAP = 10;

/**
 * Snapshot of the supervisor's view of state used to render the prompt
 * input. PHI-suppressed by construction: only category presence flags,
 * counts, the supervisor's own decision history, and prior-turn
 * pair/citation counts cross the model boundary. Patient identifiers
 * are referenced by uuid not name (see W1 `LANGSMITH_HIDE_INPUTS`).
 */
export interface SupervisorStateObservation {
    readonly iteration: number;
    readonly task: 'default_briefing' | 'follow_up';
    /**
     * The free-text follow-up question, when the envelope carries one.
     * The supervisor needs the actual question text to route content-
     * sensitive handoffs (e.g. evidenceRetriever for guideline-shaped
     * questions). PHI suppression: the question is user-typed clinician
     * input — same provenance as the chart that already crosses the
     * LangSmith boundary, and `LANGSMITH_HIDE_INPUTS=true` redacts it
     * from upload anyway. `null` for default briefings and for typed
     * `followUp` envelopes whose params don't carry free text.
     */
    readonly question: string | null;
    /**
     * Default question the supervisor should treat as the turn's
     * intent when the envelope carries pendingUploads but no
     * clinician-typed `question`. Without this projection an
     * upload-only follow-up turn presents to the supervisor as
     * "task=follow_up, question=null", which the model commonly
     * routes as "summarize the doc" — going straight from
     * kickoffExtraction to synthesize and skipping the
     * evidenceRetriever / retrieveChart fan-out the doctor would
     * actually want for an abnormal lab. Filling in a deterministic
     * "what should I do about this" question reframes the turn so the
     * existing guideline-shaped routing logic in the prompt fires.
     * `null` when the envelope already carries a question, or when
     * there are no pending uploads.
     */
    readonly implicitQuestion: string | null;
    readonly chartCategoriesPresent: readonly string[];
    readonly retrieveChartCallCount: number;
    readonly retrieversInvokedThisTurn: readonly string[];
    readonly priorTurnPairsLoaded: number;
    readonly priorCitationsCount: number;
    readonly previousDecision: SupervisorDecision | null;
    /**
     * Documents the user attached this turn, projected from
     * `state.envelope.pendingUploads`. The supervisor decides — per
     * entry — whether to fire `kickoffExtraction`. An entry whose
     * `documentUuid` is already in `kickoffExtractionResultsThisTurn`
     * has been processed in the current iteration and must not be
     * re-extracted.
     */
    readonly pendingUploads: readonly {
        readonly documentUuid: string;
        readonly docType: 'lab_pdf' | 'intake_form' | 'referral_letter';
    }[];
    /**
     * `kickoffExtraction` results appended on this turn, projected
     * minimally (uuid + status) so the supervisor can detect "already
     * extracted this uuid this turn" without seeing internal artifact
     * ids. `null` artifactId on the failed path is preserved so the
     * supervisor can route around a `failed` extraction (per
     * `W2_ARCHITECTURE.md` §"Failure isolation").
     */
    readonly kickoffExtractionResultsThisTurn: readonly {
        readonly documentUuid: string;
        readonly status: 'persisted' | 'failed';
    }[];
    /**
     * Total count for the cycle / cap heuristics. Equal to
     * `kickoffExtractionResultsThisTurn.length` today; kept distinct so
     * future fan-out across multiple uploads stays observable.
     */
    readonly kickoffExtractionResultsCount: number;
}

export interface SupervisorDecideInput {
    readonly state: BriefingState;
    readonly observation: SupervisorStateObservation;
    readonly handoffManifest: readonly SupervisorHandoffManifestEntry[];
}

export interface SupervisorHandoffManifestEntry {
    readonly handoff: SupervisorHandoff;
    readonly description: string;
}

export interface SupervisorDecisionWithUsage {
    readonly decision: SupervisorDecision;
    readonly usage?: {
        readonly model: string;
        readonly inputTokens: number;
        readonly outputTokens: number;
        /**
         * Anthropic prompt-cache breakdown via LangChain's
         * `usage_metadata.input_token_details`. Optional so existing
         * test stubs don't have to know about caching; both default to
         * 0. `inputTokens` already includes these — `costForUsage`
         * splits them back apart for accurate pricing.
         */
        readonly cacheCreationInputTokens?: number;
        readonly cacheReadInputTokens?: number;
    };
}

/**
 * The LLM seam. Production wires the real Anthropic client; tests inject
 * a stub. Returning a `SupervisorDecisionWithUsage` keeps the cost
 * counters wiring inside the node rather than the seam — the stub
 * shape stays a single object even when the test doesn't care about
 * usage.
 */
export type SupervisorDecide = (
    input: SupervisorDecideInput,
) => Promise<SupervisorDecision | SupervisorDecisionWithUsage>;

export interface CycleWarningPayload {
    readonly previous: SupervisorDecision;
    readonly current: SupervisorDecision;
    readonly iteration: number;
}

export interface SupervisorDeps {
    readonly decide: SupervisorDecide;
    /**
     * §6.1 cost-projection counters. Token usage and dollar cost get
     * recorded here per supervisor iteration. Optional so existing
     * tests can skip wiring it.
     */
    readonly counters?: Counters;
    /**
     * Iteration cap override. Defaults to `SUPERVISOR_ITERATION_CAP`.
     * Tests pin a smaller value to exercise the cap-hit path without
     * standing up a 10-step harness; production never overrides it.
     */
    readonly iterationCap?: number;
    /**
     * Optional cycle-warning sink. Production wires this to the
     * LangSmith `degenerate-loop` trace event; tests assert the call
     * directly. Per `W2_ARCHITECTURE.md` §"Cycle detection" — this is
     * observability, not termination.
     */
    readonly onCycleWarning?: (payload: CycleWarningPayload) => void;
}

/**
 * Brief manifest entries shown to the model. Wording is intentionally
 * compact — the supervisor's job is routing, not authoring; long
 * descriptions invite the model to over-think.
 */
const HANDOFF_MANIFEST: readonly SupervisorHandoffManifestEntry[] = [
    {
        handoff: 'evidenceRetriever',
        description:
            "Retrieves clinical-guideline chunks from the curated guideline corpus, which includes USPSTF (screening / prevention), ADA (diabetes), CDC (immunizations, STI screening), and AGS-Beers (geriatric medication safety). Pick FIRST whenever the user's question is about screening recommendations, screening intervals, prevention guidance, treatment thresholds, dosing rules, risk-stratification, or anything a clinician would normally answer by reaching for a published guideline rather than chart data alone. Args: { query: string, top_k?: number, source_filter?: ('USPSTF'|'ADA'|'AGS-Beers'|'CDC')[] }. Omit source_filter by default — the cross-source reranker picks the strongest match across all four publishers. Set source_filter only when the question is unambiguously scoped to one publisher (e.g. \"what does USPSTF say about\", \"per ADA standards of care\").",
    },
    {
        handoff: 'documentEvidenceRetriever',
        description:
            "Retrieves structured fact snippets (bbox + page + quote + field path) from previously extracted documents (lab PDFs, intake forms) for THIS patient. Pick when the user's question references something on a recently uploaded document, or when chart-only context isn't enough to answer a question that documents might address. Args: { query: string, doc_types?: ('lab_pdf'|'intake_form')[], lookback_days?: number, top_k?: number }.",
    },
    {
        handoff: 'retrieveChart',
        description:
            'Re-fetch chart categories. First call (deterministic) seeds the snapshot; subsequent calls accept structured args { categories: [...] } picking from ' +
            RETRIEVE_CHART_CATEGORIES.join(', ') +
            '. Pick only when the chart slot is missing a category the question requires.',
    },
    {
        handoff: 'kickoffExtraction',
        description:
            "Synchronously runs the document ingestion pipeline (rasterize → vision → schemaValidate → patientMatch → persist → emitDeltas) on a document the clinician just attached. Args: { document_uuid: string, doc_type: 'lab_pdf' | 'intake_form' } — both fields MUST be copied verbatim from one of the entries in observation.pendingUploads. Pipeline events stream back to the panel during the call; on completion, an artifact summary is appended to state.kickoffExtractionResults. Pick FIRST whenever observation.pendingUploads contains an entry whose documentUuid does not yet appear in observation.kickoffExtractionResultsThisTurn — the clinician is waiting to find out what's in the document. Forbidden when no such pending entry exists, or when every pending entry has already been processed this turn. The patient pid is taken from the envelope, not the args.",
    },
    {
        handoff: 'synthesize',
        description:
            'Terminal handoff that produces the final assistant message. Pick when chart context plus retrieved evidence is sufficient to answer the question, AND when the question does not match a guideline-shaped pattern that evidenceRetriever should have handled first.',
    },
];

const logger = createLogger('graph:supervisor');

const presentCategoryFlags = (state: BriefingState): readonly string[] => {
    const snap = state.snapshot;
    if (snap === null) return [];
    const flags: string[] = [];
    if (snap.appointment !== null) flags.push('appointment');
    if (snap.diagnoses.length > 0) flags.push('diagnoses');
    if (snap.prescriptions.length > 0) flags.push('prescriptions');
    if (snap.allergies.length > 0) flags.push('allergies');
    // labs / encounters / reminders / medications can be a Gap — mark
    // their presence by "section ran" rather than data shape, so the
    // supervisor knows the retriever was invoked even if it failed open.
    if (Array.isArray(snap.labs) && snap.labs.length > 0) flags.push('labs');
    if (Array.isArray(snap.encounters) && snap.encounters.length > 0) flags.push('encounters');
    if (Array.isArray(snap.reminders) && snap.reminders.length > 0) flags.push('reminders');
    if (Array.isArray(snap.medications) && snap.medications.length > 0) flags.push('medications');
    if (snap.labHistory !== null) flags.push('labHistory');
    return flags;
};

/**
 * Build the deterministic implicit question for an upload-only turn.
 * The phrasing is intentionally clinical and prevention-shaped — it
 * mirrors what a doctor actually wants to know after attaching a doc
 * ("did anything change", "what should I consider doing"), which is
 * exactly the kind of question the supervisor's evidenceRetriever
 * routing rule fires on. We pick the doc type from the FIRST pending
 * entry; multi-doc turns get a generic phrasing.
 */
const buildImplicitQuestion = (
    pendingUploads: readonly {
        readonly docType: 'lab_pdf' | 'intake_form' | 'referral_letter';
    }[],
): string | null => {
    if (pendingUploads.length === 0) return null;
    if (pendingUploads.length > 1) {
        return 'What do these documents tell us about the patient, and what should I consider doing about it given the chart and applicable guidelines?';
    }
    const first = pendingUploads[0];
    if (first === undefined) return null;
    switch (first.docType) {
        case 'lab_pdf':
            return 'What does this lab tell us about the patient, how does it compare to prior results, and what should I consider doing about it given applicable guidelines?';
        case 'intake_form':
            return 'What does this intake form tell us about the patient, and what should I consider doing given the chart and applicable guidelines?';
        case 'referral_letter':
            return 'What does this referral letter tell us about the patient, what is the referring provider asking us to address, and what should I consider doing given the chart and applicable guidelines?';
    }
};

const observeState = (state: BriefingState): SupervisorStateObservation => {
    const history = state.supervisorDecisionHistory;
    const pendingUploads = (state.envelope.pendingUploads ?? []).map((p) => ({
        documentUuid: p.documentUuid,
        docType: p.docType,
    }));
    const kickoffExtractionResultsThisTurn = state.kickoffExtractionResults.map((r) => ({
        documentUuid: r.documentUuid,
        status: r.status,
    }));
    const explicitQuestion =
        typeof state.envelope.question === 'string' && state.envelope.question.length > 0
            ? state.envelope.question
            : null;
    // Implicit question fires only when the envelope has uploads AND
    // no typed question — a turn with both should treat the typed
    // text as authoritative.
    const implicitQuestion =
        explicitQuestion === null ? buildImplicitQuestion(pendingUploads) : null;
    return {
        iteration: state.supervisorIterations + 1,
        task: state.envelope.task,
        question: explicitQuestion,
        implicitQuestion,
        chartCategoriesPresent: presentCategoryFlags(state),
        retrieveChartCallCount: state.retrieveChartCallCount,
        retrieversInvokedThisTurn: history.map((d) => d.handoff),
        priorTurnPairsLoaded: Math.floor(state.priorTurnContext.turns.length / 2),
        priorCitationsCount: state.priorTurnContext.turns.reduce(
            (acc, t) => (t.role === 'assistant' ? acc + t.citations.length : acc),
            0,
        ),
        previousDecision: history.at(-1) ?? null,
        pendingUploads,
        kickoffExtractionResultsThisTurn,
        kickoffExtractionResultsCount: state.kickoffExtractionResults.length,
    };
};

const isDecisionWithUsage = (
    value: SupervisorDecision | SupervisorDecisionWithUsage,
): value is SupervisorDecisionWithUsage => {
    return 'decision' in value && typeof value.decision === 'object';
};

/**
 * Narrow `retrieveChart`'s loose `Record<string, unknown>` args into the
 * typed `RetrieveChartArgs` shape. Throws on:
 *  - missing `categories`,
 *  - empty `categories`,
 *  - any value outside the closed `RetrieveChartCategory` enum.
 *
 * The thrown error surfaces as a typed error in the runner — the graph
 * does not get to route on garbage even if `withStructuredOutput`
 * accepted it (the args field is `unknown` per the architecture).
 */
const narrowRetrieveChartArgs = (args: Record<string, unknown> | undefined): RetrieveChartArgs => {
    const categories = args?.['categories'];
    if (!Array.isArray(categories)) {
        throw new Error('supervisor: retrieveChart handoff requires args.categories: string[]');
    }
    if (categories.length === 0) {
        throw new Error('supervisor: retrieveChart args.categories must be non-empty');
    }
    const allowed = new Set<string>(RETRIEVE_CHART_CATEGORIES);
    for (const c of categories) {
        if (typeof c !== 'string' || !allowed.has(c)) {
            throw new Error(
                `supervisor: retrieveChart args.categories contains unknown value: ${String(c)}`,
            );
        }
    }
    return { categories: categories as RetrieveChartArgs['categories'] };
};

/**
 * Generic guideline-shaped query for a `default_briefing` turn that
 * carries neither a typed clinician question nor an upload — i.e. a
 * morning-prep kickoff where the LLM still wants to reach for
 * authoritative evidence on top of the chart. retrieveChart has
 * already populated `state.snapshot` by the time the supervisor runs
 * (graph wiring: START → retrieveChart → supervisor), so the model
 * has the chart in context when it formulates its actual retriever
 * args; this string is only the fallback when the model picked a
 * retriever without writing args.query.
 */
const DEFAULT_BRIEFING_FALLBACK_QUERY =
    "For this patient's active conditions, current medications, and recent results, what guideline-based actions, screenings, or follow-up should I consider?";

/**
 * Recover a usable retriever query when the supervisor LLM picked a
 * retriever handoff but didn't fill in `args.query`. Production
 * Anthropic with `withStructuredOutput` is mostly reliable about this,
 * but real-model evals (and prod) have surfaced occasional handoffs
 * with `{ handoff: 'evidenceRetriever', reason: …, narration: … }` and
 * no `args` — the model effectively meant "look up something for this
 * question" without restating it. Falling back keeps the run useful
 * instead of throwing the graph on the floor.
 *
 * Sources, in priority order:
 *   1. envelope.question — the clinician typed something explicit.
 *   2. implicit upload question — the envelope carried docs, no typed
 *      question (a chart-side document or a chat-panel attachment).
 *   3. default_briefing kickoff fallback — morning-prep with neither a
 *      question nor uploads. Returns a generic guideline-shaped query
 *      so the retriever still has something to work with against the
 *      chart context the model already has in scope.
 *
 * Returns null only when none of those sources apply (currently:
 * follow_up turns with no question and no uploads, which the
 * envelope schema rejects upstream — but the null branch is preserved
 * for defense in depth).
 */
const fallbackQueryFromState = (state: BriefingState): string | null => {
    const explicit = state.envelope.question;
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
        return explicit.trim();
    }
    const implicit = buildImplicitQuestion(
        (state.envelope.pendingUploads ?? []).map((p) => ({ docType: p.docType })),
    );
    if (implicit !== null && implicit.trim().length > 0) {
        return implicit.trim();
    }
    if (state.envelope.task === 'default_briefing') {
        return DEFAULT_BRIEFING_FALLBACK_QUERY;
    }
    return null;
};

/**
 * §C.1 narrow `documentEvidenceRetriever`'s loose args into the typed
 * {@link DocumentEvidenceArgs} shape via {@link DocumentEvidenceArgsSchema}.
 * Defaults (`lookback_days: 90`, `top_k: 5`) bind here so the node sees
 * a fully-populated value.
 *
 * Recovery: if `args` is missing entirely or its `query` field is
 * missing/empty, fall back to `fallbackQuery` (typically the envelope
 * question). Throws only when no fallback is available either — the
 * runner still surfaces a typed error in that genuinely-malformed
 * case, but a real run with a typed clinical question never gets
 * crashed by a brittle LLM omission.
 */
const narrowDocumentEvidenceArgs = (
    args: Record<string, unknown> | undefined,
    fallbackQuery: string | null,
): DocumentEvidenceArgs => {
    const merged: Record<string, unknown> =
        args === undefined ? {} : { ...args };
    const rawQuery = merged['query'];
    const queryProvided = typeof rawQuery === 'string' && rawQuery.trim().length > 0;
    if (!queryProvided) {
        if (fallbackQuery === null) {
            throw new Error(
                'supervisor: documentEvidenceRetriever handoff requires args: { query, ... } and no fallback question is available',
            );
        }
        merged['query'] = fallbackQuery;
        logger.warn(
            { fallbackQueryLength: fallbackQuery.length },
            'supervisor: documentEvidenceRetriever picked without args.query — recovering with envelope question',
        );
    }
    return DocumentEvidenceArgsSchema.parse(merged);
};

/**
 * §C.3 narrow `evidenceRetriever`'s loose args into the typed
 * {@link EvidenceArgs} shape via {@link EvidenceArgsSchema}. Defaults
 * (`top_k: 3`) bind here so the node sees a fully-populated value.
 *
 * Same recovery semantics as `narrowDocumentEvidenceArgs`: missing args
 * or missing query falls back to the envelope question; only throws
 * when no fallback exists.
 */
const narrowEvidenceArgs = (
    args: Record<string, unknown> | undefined,
    fallbackQuery: string | null,
): EvidenceArgs => {
    const merged: Record<string, unknown> =
        args === undefined ? {} : { ...args };
    const rawQuery = merged['query'];
    const queryProvided = typeof rawQuery === 'string' && rawQuery.trim().length > 0;
    if (!queryProvided) {
        if (fallbackQuery === null) {
            throw new Error(
                'supervisor: evidenceRetriever handoff requires args: { query, ... } and no fallback question is available',
            );
        }
        merged['query'] = fallbackQuery;
        logger.warn(
            { fallbackQueryLength: fallbackQuery.length },
            'supervisor: evidenceRetriever picked without args.query — recovering with envelope question',
        );
    }
    return EvidenceArgsSchema.parse(merged);
};

const sameDecisionAsPrevious = (
    previous: SupervisorDecision | null,
    current: SupervisorDecision,
): boolean => {
    if (previous === null) return false;
    if (previous.handoff !== current.handoff) return false;
    // Args equality is intentionally shallow: re-picking the same
    // handoff with materially different args is not a cycle (the model
    // is iterating on a query). Compare via JSON for the loose
    // unknown-record shape; ordering of keys matters less than identity
    // of the args payload.
    const prevArgs = previous.args === undefined ? null : JSON.stringify(previous.args);
    const currArgs = current.args === undefined ? null : JSON.stringify(current.args);
    return prevArgs === currArgs;
};

const buildCapHitDecision = (): SupervisorDecision => ({
    handoff: 'synthesize',
    reason: 'iteration cap reached — forcing synthesize',
    narration: 'Drafting your briefing.',
});

export const createSupervisor = (
    deps: SupervisorDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const counters = deps.counters ?? createNoopCounters();
    const cap = deps.iterationCap ?? SUPERVISOR_ITERATION_CAP;

    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        // Cap-hit path. The architecture pins this as deterministic — at
        // iteration N === cap, force synthesize with capHit=true; the
        // LLM is never called. Eval cases pin both the boolean and the
        // trace event.
        if (state.supervisorIterations >= cap) {
            const forced = buildCapHitDecision();
            const previous = state.supervisorDecisionHistory.at(-1) ?? null;
            setRunMetadata({
                supervisor_event: 'cap-hit',
                supervisor_iteration: state.supervisorIterations,
                supervisor_last_decision: previous?.handoff ?? null,
                supervisor_last_reason: previous?.reason ?? null,
            });
            logger.warn(
                {
                    iteration: state.supervisorIterations,
                    last_decision: previous?.handoff ?? null,
                },
                'supervisor cap-hit; forcing synthesize',
            );
            return {
                supervisorIterations: state.supervisorIterations + 1,
                supervisorDecisionHistory: [...state.supervisorDecisionHistory, forced],
                capHit: true,
            };
        }

        const observation = observeState(state);
        const result = await deps.decide({
            state,
            observation,
            handoffManifest: HANDOFF_MANIFEST,
        });

        const decision: SupervisorDecision = isDecisionWithUsage(result) ? result.decision : result;
        const usage = isDecisionWithUsage(result) ? result.usage : undefined;

        // Validate the structured shape one more time. `withStructuredOutput`
        // already coerces, but the seam may be stubbed in tests, and a
        // hand-rolled stub that returns a malformed object would
        // otherwise reach the graph. Per `W2_ARCHITECTURE.md`
        // §"Structural-output coercion via Zod (rejects malformed model
        // output before it reaches graph state)".
        SupervisorDecisionSchema.parse(decision);

        // Per-handoff arg narrowing. Each typed-slot handoff narrows
        // the loose `Record<string, unknown>` decision args into a
        // typed shape before they reach state.
        let retrieveChartArgs: RetrieveChartArgs | undefined;
        let documentEvidenceArgs: DocumentEvidenceArgs | undefined;
        let evidenceRetrieverArgs: EvidenceArgs | undefined;
        if (decision.handoff === 'retrieveChart') {
            // First call is deterministic and ignores args; the
            // architecture allows the supervisor to hand off without
            // args on iteration 1 because `retrieveChart` will run the
            // full fan-out anyway.
            if (state.retrieveChartCallCount > 0) {
                retrieveChartArgs = narrowRetrieveChartArgs(decision.args);
            }
        } else if (decision.handoff === 'documentEvidenceRetriever') {
            documentEvidenceArgs = narrowDocumentEvidenceArgs(
                decision.args,
                fallbackQueryFromState(state),
            );
        } else if (decision.handoff === 'evidenceRetriever') {
            evidenceRetrieverArgs = narrowEvidenceArgs(
                decision.args,
                fallbackQueryFromState(state),
            );
        }

        // Cycle detection. Re-picking the same handoff with the same
        // args and no new retriever output between is a degenerate
        // loop. We log via the warning sink and via the trace event;
        // termination is the cap's job.
        const previous = state.supervisorDecisionHistory.at(-1) ?? null;
        if (previous !== null && sameDecisionAsPrevious(previous, decision)) {
            deps.onCycleWarning?.({
                previous,
                current: decision,
                iteration: observation.iteration,
            });
            setRunMetadata({
                supervisor_event: 'degenerate-loop',
                supervisor_iteration: observation.iteration,
                supervisor_handoff: decision.handoff,
            });
            logger.warn(
                {
                    iteration: observation.iteration,
                    handoff: decision.handoff,
                },
                'supervisor degenerate-loop warning',
            );
        }

        // Per-iteration trace event. PHI-suppressed by construction —
        // observation only carries flags + counts. Token cost flows
        // through the standard cost helper so the supervisor line item
        // shows up in the cost-per-turn rollup.
        const costUsd = usage !== undefined ? costForUsage(usage) : 0;
        const cacheCreationInputTokens = usage?.cacheCreationInputTokens ?? 0;
        const cacheReadInputTokens = usage?.cacheReadInputTokens ?? 0;
        if (usage !== undefined) {
            counters.recordModelUsage({
                model: usage.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd,
                cacheCreationInputTokens,
                cacheReadInputTokens,
            });
        }
        // `decision.reason`, `decision.args`, and `decision.narration` are
        // unbounded LLM output. The trace-metadata channel bypasses both
        // Pino redaction (logger-only) and `LANGSMITH_HIDE_INPUTS/OUTPUTS`
        // (which only blanks inputs/outputs, not metadata). Scrub each
        // through `scrubLlmTextForTrace` so a model that blends a patient
        // name into the rationale lands a sentinel on the trace, not
        // free-text PHI. Cardinality at the field level is preserved so
        // dashboards still see "this slot exists this iteration."
        setRunMetadata({
            supervisor_event: 'iteration',
            supervisor_iteration: observation.iteration,
            supervisor_state_observed: observation,
            supervisor_handoff_manifest: HANDOFF_MANIFEST.map((m) => m.handoff),
            supervisor_decision: decision.handoff,
            supervisor_reason: scrubLlmTextForTrace(decision.reason),
            supervisor_narration: scrubLlmTextForTrace(decision.narration),
            supervisor_args: scrubLlmTextForTrace(decision.args ?? null),
            ...(usage !== undefined
                ? {
                      supervisor_input_tokens: usage.inputTokens,
                      supervisor_output_tokens: usage.outputTokens,
                      supervisor_dollar_cost: costUsd,
                      supervisor_cache_creation_input_tokens: cacheCreationInputTokens,
                      supervisor_cache_read_input_tokens: cacheReadInputTokens,
                  }
                : {}),
        });

        return {
            supervisorIterations: state.supervisorIterations + 1,
            supervisorDecisionHistory: [...state.supervisorDecisionHistory, decision],
            ...(retrieveChartArgs !== undefined ? { retrieveChartArgs } : {}),
            ...(documentEvidenceArgs !== undefined ? { documentEvidenceArgs } : {}),
            ...(evidenceRetrieverArgs !== undefined ? { evidenceRetrieverArgs } : {}),
        };
    };

    return traceable(impl, { name: 'supervisor', run_type: 'chain' });
};

/**
 * Default `SupervisorDecide` backed by ChatAnthropic +
 * `withStructuredOutput(SupervisorDecisionSchema)`. The model picks
 * from the closed handoff enum and returns
 * `{handoff, reason, args?}` — anything else fails coercion and the
 * runner surfaces a typed error.
 *
 *   ANTHROPIC_MODEL_SUPERVISOR → defaults to claude-sonnet-4-6
 *
 * Sonnet rather than Haiku because the supervisor's job is routing
 * across an 8-handoff manifest plus prior context — the price table
 * absorbs the 3–6 iterations per turn at MVP scale, and routing
 * accuracy is the load-bearing eval gate.
 */
const DEFAULT_SUPERVISOR_MODEL = 'claude-sonnet-4-6';

const SUPERVISOR_SYSTEM_PROMPT = `You are the supervisor of a clinical-copilot agent. Your job is to choose the next handoff that will best advance the clinician's question, picking from a closed enumeration.

Rules:
- Pick exactly one handoff from the manifest.
- Provide a non-empty reason — you are accountable for every routing decision.
- Provide a one-sentence narration (≤120 chars), written for the clinician watching the panel: a clear, concrete description of what you're about to do, in present continuous tense. Examples: "Pulling prior lipid panels to compare." / "Checking the USPSTF on statin primary prevention." / "Analyzing the lipid panel you just attached." / "Drafting your briefing." It will be shown verbatim as the panel's progress line for this step. Avoid jargon, internal handoff names, and technical detail.
- When the envelope carries pendingUploads (documents the clinician just attached) and any entry has not yet been processed this turn (its documentUuid is absent from observation.kickoffExtractionResultsThisTurn), kickoffExtraction is usually the right first move — copy { document_uuid, doc_type } from the pending entry verbatim into args. The two cases where you should SKIP kickoffExtraction even though pendingUploads has unprocessed entries: (a) on a 'follow_up' task with an explicit observation.question that does not reference the attached document(s) — the clinician asked something specific and is waiting on an answer, not on us to re-process documents that were already surfaced in a previous turn (chart-side documents enriched by the briefing runner can re-appear on every turn until the user dismisses them); answer the question first via the normal evidence/synthesize path. (b) When every pending entry has already produced a 'failed' result you can route around. Otherwise, until every pending entry has been processed, do not pick synthesize. After kickoffExtraction completes, decide on the next iteration what additional context the extracted document warrants — for a lab, prior trending via retrieveChart('lab') is often valuable; for a question the document raises, evidenceRetriever may add guideline backing; for grounding a citation in the extracted facts, documentEvidenceRetriever surfaces the structured snippets.
- When observation.implicitQuestion is set (the envelope carried documents but no typed question), treat it as if the clinician asked it explicitly. The same routing rules below — guideline-shaped routing to evidenceRetriever, chart-only lookups direct to synthesize, etc. — apply unchanged. Concretely: an implicit "what should I consider doing about this lab" against a chart with abnormal results almost always benefits from evidenceRetriever before synthesize. Do not skip evidenceRetriever just because the question is implicit.
- When you pick retrieveChart on a turn that has already retrieved chart data once, you must include args.categories naming which categories to re-fetch.
- Pick synthesize only when chart context plus retrieved evidence is sufficient to answer the question. The synthesizer is forbidden from citing clinical knowledge from its own training data — its only valid sources are this turn's chart records and any retriever output already in state.
- Decide before each handoff: would the answer benefit from authoritative guideline backing? If yes, pick evidenceRetriever first. The synthesizer is forbidden from naming named guidelines (USPSTF, ADA, AHA, JNC, etc.) unless they appear as snippets in state — so routing directly to synthesize for a guideline-shaped question yields a chart-only answer the clinician will read as "you didn't actually look it up." Triggers include but are not limited to: prevention guidance ("should X be on aspirin"), screening intervals ("when is the next mammogram due"), treatment thresholds ("at what BP do we start medication"), dosing rules, risk-stratification, and any question that would normally be answered by reaching for a clinical guideline rather than the chart alone. ONLY skip evidenceRetriever when the question is purely a chart-data lookup ("when was her last visit", "what's her current Rx list").
- For follow-up questions that reference a recently uploaded document or where the chart alone won't answer a question that documents likely address — pick documentEvidenceRetriever before synthesize.
- Do not invent handoffs; do not invent arg shapes outside the documented per-handoff schema.`;

const buildUserPrompt = (input: SupervisorDecideInput): string => {
    const obs = input.observation;
    const manifest = input.handoffManifest
        .map((m) => `- ${m.handoff}: ${m.description}`)
        .join('\n');
    const decisionHistory =
        input.state.supervisorDecisionHistory.length === 0
            ? '(none yet this turn)'
            : input.state.supervisorDecisionHistory
                  .map(
                      (d, i) =>
                          `${i + 1}. ${d.handoff} — ${d.reason}` +
                          (d.args !== undefined ? ` (args: ${JSON.stringify(d.args)})` : ''),
                  )
                  .join('\n');
    return [
        '<HANDOFF_MANIFEST>',
        manifest,
        '</HANDOFF_MANIFEST>',
        '',
        '<STATE_OBSERVATION>',
        JSON.stringify(obs, null, 2),
        '</STATE_OBSERVATION>',
        '',
        '<DECISION_HISTORY_THIS_TURN>',
        decisionHistory,
        '</DECISION_HISTORY_THIS_TURN>',
        '',
        'Choose the next handoff. Respond with the structured object only.',
    ].join('\n');
};

export const createAnthropicSupervisorDecide = (options?: {
    readonly model?: string;
    readonly apiKey?: string;
}): SupervisorDecide => {
    const model =
        options?.model ?? process.env['ANTHROPIC_MODEL_SUPERVISOR'] ?? DEFAULT_SUPERVISOR_MODEL;
    const apiKey = options?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('ANTHROPIC_API_KEY is required to build the default supervisor');
    }
    const structured = new ChatAnthropic({ model, apiKey, temperature: 0 }).withStructuredOutput(
        SupervisorDecisionSchema,
        {
            name: 'supervisor_decision',
            includeRaw: true,
        },
    );
    return async (input) => {
        // Mark the system prompt as a prompt-cache breakpoint. The
        // supervisor loops up to SUPERVISOR_ITERATION_CAP times per turn
        // with this same prompt, so iterations 2..N read it from cache
        // at ~10% of the normal input rate. LangChain passes a content
        // array on a SystemMessage straight through to Anthropic's
        // `system` field, so the `cache_control` marker rides along.
        const result = await structured.invoke([
            new SystemMessage({
                content: [
                    {
                        type: 'text',
                        text: SUPERVISOR_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
            }),
            new HumanMessage(buildUserPrompt(input)),
        ]);
        const parsed = result.parsed;
        const raw = result.raw;
        if (parsed === null || parsed === undefined) {
            // `withStructuredOutput({ includeRaw: true })` sets `parsed`
            // to null when JSON-coercion fails. The supervisor's caller
            // runs `SupervisorDecisionSchema.parse(decision)` next,
            // which would NPE on null without an explicit message. The
            // thrown error carries a bounded excerpt of the raw model
            // output so the LangSmith trace (and eval failure card)
            // has enough signal to diagnose without re-running.
            throw structuredOutputParseError('supervisor', raw);
        }
        const usageMeta = (
            raw as {
                usage_metadata?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    input_token_details?: {
                        cache_creation?: number;
                        cache_read?: number;
                    };
                };
            }
        ).usage_metadata;
        const usage =
            usageMeta !== undefined
                ? {
                      model,
                      inputTokens: usageMeta.input_tokens ?? 0,
                      outputTokens: usageMeta.output_tokens ?? 0,
                      cacheCreationInputTokens:
                          usageMeta.input_token_details?.cache_creation ?? 0,
                      cacheReadInputTokens: usageMeta.input_token_details?.cache_read ?? 0,
                  }
                : undefined;
        return {
            decision: parsed,
            ...(usage !== undefined ? { usage } : {}),
        };
    };
};
