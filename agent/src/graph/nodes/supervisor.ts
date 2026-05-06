import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { traceable } from 'langsmith/traceable';

import type { Counters } from '../../observability/counters.js';
import { createNoopCounters } from '../../observability/counters.js';
import { createLogger } from '../../observability/logger.js';
import { costForUsage, setRunMetadata } from '../../observability/traceMetadata.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
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
    readonly chartCategoriesPresent: readonly string[];
    readonly retrieveChartCallCount: number;
    readonly retrieversInvokedThisTurn: readonly string[];
    readonly priorTurnPairsLoaded: number;
    readonly priorCitationsCount: number;
    readonly previousDecision: SupervisorDecision | null;
    /**
     * §B.9 count of `kickoffExtraction` results already appended this
     * turn (any status — `persisted` or `failed`). The supervisor uses
     * this to avoid re-extracting a document the same turn already
     * processed; the manifest entry steers it explicitly.
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
            "Retrieves clinical-guideline chunks from the curated guideline corpus (USPSTF). Pick FIRST whenever the user's question is about screening recommendations, screening intervals, prevention guidance, treatment thresholds, dosing rules, risk-stratification, or anything a clinician would normally answer by reaching for a published guideline rather than chart data alone. Args: { query: string, top_k?: number, source_filter?: ('USPSTF')[] }.",
    },
    {
        handoff: 'documentEvidenceRetriever',
        description:
            "Retrieves structured fact snippets (bbox + page + quote + field path) from previously extracted documents (lab PDFs, intake forms) for THIS patient. Pick when the user's question references something on a recently uploaded document, or when chart-only context isn't enough to answer a question that documents might address. Args: { query: string, doc_types?: ('lab_pdf'|'intake_form')[], lookback_days?: number, top_k?: number }.",
    },
    {
        handoff: 'retrieveChart',
        description:
            "Re-fetch chart categories. First call (deterministic) seeds the snapshot; subsequent calls accept structured args { categories: [...] } picking from " +
            RETRIEVE_CHART_CATEGORIES.join(', ') +
            ". Pick only when the chart slot is missing a category the question requires.",
    },
    {
        handoff: 'prescriptionChangeBranch',
        description:
            "UC3 deterministic prescription-change branch. Pick ONLY when the envelope's followUp.type is 'prescription_change'. Forbidden otherwise.",
    },
    {
        handoff: 'reminderBranch',
        description:
            "UC4.6.5 deterministic reminder-detail branch. Pick ONLY when followUp.type is 'reminder_detail'. Forbidden otherwise.",
    },
    {
        handoff: 'medicationStatementBranch',
        description:
            "UC4.6.6 deterministic medication-statement-detail branch. Pick ONLY when followUp.type is 'medication_statement_detail'. Forbidden otherwise.",
    },
    {
        handoff: 'kickoffExtraction',
        description:
            "Synchronously runs the document ingestion pipeline (rasterize → vision → schemaValidate → patientMatch → persist → emitDeltas) on an unprocessed document already uploaded for this patient. Args: { document_uuid: string, doc_type: 'lab_pdf' | 'intake_form' }. Pipeline events stream back to the panel during the call; on completion, an artifact summary is appended to state.kickoffExtractionResults. Pick ONLY when prior-turn context or chart state surfaces a pending document_uuid that this turn has not yet processed (state.kickoffExtractionResults does not already contain it). Forbidden when no such document_uuid is in scope — picking it otherwise wastes an iteration. The patient pid is taken from the envelope, not the args.",
    },
    {
        handoff: 'synthesize',
        description:
            "Terminal handoff that produces the final assistant message. Pick when chart context plus retrieved evidence is sufficient to answer the question, AND when the question does not match a guideline-shaped pattern that evidenceRetriever should have handled first.",
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

const observeState = (state: BriefingState): SupervisorStateObservation => {
    const history = state.supervisorDecisionHistory;
    return {
        iteration: state.supervisorIterations + 1,
        task: state.envelope.task,
        question: typeof state.envelope.question === 'string' && state.envelope.question.length > 0
            ? state.envelope.question
            : null,
        chartCategoriesPresent: presentCategoryFlags(state),
        retrieveChartCallCount: state.retrieveChartCallCount,
        retrieversInvokedThisTurn: history.map((d) => d.handoff),
        priorTurnPairsLoaded: Math.floor(state.priorTurnContext.turns.length / 2),
        priorCitationsCount: state.priorTurnContext.turns.reduce(
            (acc, t) => (t.role === 'assistant' ? acc + t.citations.length : acc),
            0,
        ),
        previousDecision: history.at(-1) ?? null,
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
const narrowRetrieveChartArgs = (
    args: Record<string, unknown> | undefined,
): RetrieveChartArgs => {
    const categories = args?.['categories'];
    if (!Array.isArray(categories)) {
        throw new Error(
            'supervisor: retrieveChart handoff requires args.categories: string[]',
        );
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
 * §C.1 narrow `documentEvidenceRetriever`'s loose args into the typed
 * {@link DocumentEvidenceArgs} shape via {@link DocumentEvidenceArgsSchema}.
 * Defaults (`lookback_days: 90`, `top_k: 5`) bind here so the node sees
 * a fully-populated value.
 *
 * Throws on missing args, missing `query`, or out-of-range bounds — the
 * runner surfaces a typed error rather than letting the graph route on
 * a malformed payload. (The Zod schema rejects `doc_types: []` as well,
 * so an empty array can't slip past via the model's structured output.)
 */
const narrowDocumentEvidenceArgs = (
    args: Record<string, unknown> | undefined,
): DocumentEvidenceArgs => {
    if (args === undefined) {
        throw new Error(
            'supervisor: documentEvidenceRetriever handoff requires args: { query, ... }',
        );
    }
    return DocumentEvidenceArgsSchema.parse(args);
};

/**
 * §C.3 narrow `evidenceRetriever`'s loose args into the typed
 * {@link EvidenceArgs} shape via {@link EvidenceArgsSchema}. Defaults
 * (`top_k: 3`) bind here so the node sees a fully-populated value.
 *
 * Throws on missing args, missing `query`, out-of-range `top_k`, or an
 * empty `source_filter`. Same contract as `narrowDocumentEvidenceArgs`
 * — the runner surfaces a typed error rather than letting the graph
 * route on a malformed payload.
 */
const narrowEvidenceArgs = (
    args: Record<string, unknown> | undefined,
): EvidenceArgs => {
    if (args === undefined) {
        throw new Error(
            'supervisor: evidenceRetriever handoff requires args: { query, ... }',
        );
    }
    return EvidenceArgsSchema.parse(args);
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
                supervisorDecisionHistory: [
                    ...state.supervisorDecisionHistory,
                    forced,
                ],
                capHit: true,
            };
        }

        const observation = observeState(state);
        const result = await deps.decide({
            state,
            observation,
            handoffManifest: HANDOFF_MANIFEST,
        });

        const decision: SupervisorDecision = isDecisionWithUsage(result)
            ? result.decision
            : result;
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
        // typed shape before they reach state. The remaining handoffs
        // either no-op (Phase-A stubs B will replace) or read their
        // args from the envelope (deterministic branches).
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
            documentEvidenceArgs = narrowDocumentEvidenceArgs(decision.args);
        } else if (decision.handoff === 'evidenceRetriever') {
            evidenceRetrieverArgs = narrowEvidenceArgs(decision.args);
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
        if (usage !== undefined) {
            counters.recordModelUsage({
                model: usage.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd,
            });
        }
        setRunMetadata({
            supervisor_event: 'iteration',
            supervisor_iteration: observation.iteration,
            supervisor_state_observed: observation,
            supervisor_handoff_manifest: HANDOFF_MANIFEST.map((m) => m.handoff),
            supervisor_decision: decision.handoff,
            supervisor_reason: decision.reason,
            supervisor_args: decision.args ?? null,
            ...(usage !== undefined
                ? {
                      supervisor_input_tokens: usage.inputTokens,
                      supervisor_output_tokens: usage.outputTokens,
                      supervisor_dollar_cost: costUsd,
                  }
                : {}),
        });

        return {
            supervisorIterations: state.supervisorIterations + 1,
            supervisorDecisionHistory: [
                ...state.supervisorDecisionHistory,
                decision,
            ],
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
- When you pick retrieveChart on a turn that has already retrieved chart data once, you must include args.categories naming which categories to re-fetch.
- Pick synthesize only when chart context plus retrieved evidence is sufficient to answer the question. The synthesizer is forbidden from citing clinical knowledge from its own training data — its only valid sources are this turn's chart records and any retriever output already in state.
- Decide before each handoff: would the answer benefit from authoritative guideline backing? If yes, pick evidenceRetriever first. The synthesizer is forbidden from naming named guidelines (USPSTF, ADA, AHA, JNC, etc.) unless they appear as snippets in state — so routing directly to synthesize for a guideline-shaped question yields a chart-only answer the clinician will read as "you didn't actually look it up." Triggers include but are not limited to: prevention guidance ("should X be on aspirin"), screening intervals ("when is the next mammogram due"), treatment thresholds ("at what BP do we start medication"), dosing rules, risk-stratification, and any question that would normally be answered by reaching for a clinical guideline rather than the chart alone. ONLY skip evidenceRetriever when the question is purely a chart-data lookup ("when was her last visit", "what's her current Rx list").
- For follow-up questions that reference a recently uploaded document or where the chart alone won't answer a question that documents likely address — pick documentEvidenceRetriever before synthesize.
- The deterministic branches (prescriptionChangeBranch, reminderBranch, medicationStatementBranch) are appropriate only when the envelope's followUp.type matches.
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
                          (d.args !== undefined
                              ? ` (args: ${JSON.stringify(d.args)})`
                              : ''),
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
        options?.model
        ?? process.env['ANTHROPIC_MODEL_SUPERVISOR']
        ?? DEFAULT_SUPERVISOR_MODEL;
    const apiKey = options?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('ANTHROPIC_API_KEY is required to build the default supervisor');
    }
    const structured = new ChatAnthropic({ model, apiKey, temperature: 0 })
        .withStructuredOutput(SupervisorDecisionSchema, {
            name: 'supervisor_decision',
            includeRaw: true,
        });
    return async (input) => {
        const result = await structured.invoke([
            new SystemMessage(SUPERVISOR_SYSTEM_PROMPT),
            new HumanMessage(buildUserPrompt(input)),
        ]);
        const parsed = result.parsed;
        const raw = result.raw;
        if (parsed === null || parsed === undefined) {
            // `withStructuredOutput({ includeRaw: true })` sets `parsed`
            // to null when JSON-coercion fails. The supervisor's caller
            // runs `SupervisorDecisionSchema.parse(decision)` next,
            // which would NPE on null without an explicit message.
            throw new Error('supervisor: structured output failed to parse');
        }
        const usageMeta = (raw as {
            usage_metadata?: { input_tokens?: number; output_tokens?: number };
        }).usage_metadata;
        const usage =
            usageMeta !== undefined
                ? {
                      model,
                      inputTokens: usageMeta.input_tokens ?? 0,
                      outputTokens: usageMeta.output_tokens ?? 0,
                  }
                : undefined;
        return {
            decision: parsed,
            ...(usage !== undefined ? { usage } : {}),
        };
    };
};
