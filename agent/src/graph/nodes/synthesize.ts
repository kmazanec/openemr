import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import type { Counters } from '../../observability/counters.js';
import { createNoopCounters } from '../../observability/counters.js';
import { costForUsage, setRunMetadata } from '../../observability/traceMetadata.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import {
    FOLLOW_UP_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    buildFollowUpUserMessage,
    buildUserMessage,
} from '../synthesize.prompt.js';
import type {
    BriefingSnapshot,
    ClaimLedger,
    DraftBriefing,
    RequestEnvelope,
} from '../types.js';

/**
 * Zod schema for the structured output the model emits. Mirrors
 * `DraftBriefing` (segmented prose) + `ClaimLedger` in `types.ts`.
 * `withStructuredOutput` coerces the model into this shape and retries on
 * a malformed parse, giving us strict-JSON behavior without hand-rolled
 * repair logic.
 *
 * Cross-validation that every `claimIds` entry actually appears in the
 * ledger lives in `format.ts`, not the schema. A model that names a
 * missing id should produce a redacted segment, not a hard parse failure
 * that costs a retry.
 */
const sourceReferenceSchema = z.object({
    system: z.string().min(1),
    recordType: z.string().min(1),
    recordId: z.string().min(1),
    field: z.string().nullable(),
    recordedAt: z.string().nullable(),
});

const claimSchema = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    category: z.enum([
        'medication',
        'lab',
        'allergy',
        'diagnosis',
        'encounter',
        'appointment',
        'identity',
    ]),
    sourceReferences: z.array(sourceReferenceSchema).min(1),
    safetyCritical: z.boolean(),
});

const draftSegmentSchema = z.object({
    text: z.string().min(1),
    claimIds: z.array(z.string().min(1)),
});

const synthesisOutputSchema = z.object({
    segments: z
        .array(draftSegmentSchema)
        .min(1)
        .describe(
            'Ordered prose segments the physician will read. Each segment lists the ledger claim ids that back it; connector segments use an empty claimIds array.',
        ),
    ledger: z
        .object({
            claims: z.array(claimSchema),
        })
        .describe('Every factual claim referenced by the segments, with the source records that back it.'),
});

export interface SynthesizerUsage {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
}

export interface SynthesizerResult {
    readonly draft: DraftBriefing;
    readonly ledger: ClaimLedger;
    /**
     * Token + model identity for cost projection. Optional because
     * tests inject a deterministic `Synthesizer` that doesn't go through
     * a real model — they may omit it without affecting graph behavior.
     */
    readonly usage?: SynthesizerUsage;
}

export type Synthesizer = (input: {
    snapshot: BriefingSnapshot;
    /**
     * §4.5 free-text routing: the synthesizer reads `envelope.task` and
     * `envelope.question` to choose between the briefing and follow-up
     * prompts. Tests that don't care about routing can pass any envelope
     * with `task: 'default_briefing'`; the production synthesizer
     * inspects both fields.
     */
    envelope: RequestEnvelope;
}) => Promise<SynthesizerResult>;

export interface SynthesizeDeps {
    readonly synthesizer: Synthesizer;
    /**
     * §6.1 cost-projection counters. Token usage and dollar cost get
     * recorded here per synthesizer call. Optional so existing tests can
     * skip wiring it.
     */
    readonly counters?: Counters;
}

export const createSynthesize = (
    deps: SynthesizeDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const counters = deps.counters ?? createNoopCounters();
    return async (state) => {
        if (state.snapshot === null) {
            throw new Error('Synthesize called before Retrieve populated the snapshot');
        }
        const { draft, ledger, usage } = await deps.synthesizer({
            snapshot: state.snapshot,
            envelope: state.envelope,
        });
        if (usage !== undefined) {
            const costUsd = costForUsage(usage);
            counters.recordModelUsage({
                model: usage.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd,
            });
            setRunMetadata({
                model: usage.model,
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cost_usd: costUsd,
            });
        }
        return { draft, claimLedger: ledger };
    };
};

/**
 * Default `Synthesizer` backed by ChatAnthropic + structured output.
 * Strict JSON via `withStructuredOutput(zodSchema)` — LangChain handles
 * JSON-coercion and retry-on-parse-error.
 *
 * Per-task model routing. The briefing path is dominated by
 * structured retrieval over a known snapshot; the follow-up path
 * answers free-form clinician questions and benefits from the larger
 * model. Each task reads its own env var, falling back to a hardcoded
 * default. Both defaults match the price table in `traceMetadata.ts`.
 *
 *   ANTHROPIC_MODEL_BRIEFING  → briefing path (default haiku)
 *   ANTHROPIC_MODEL_FOLLOW_UP → free-text follow-up (default sonnet)
 *
 * Callers can still pin a single model via `options.model` (used by
 * tests and the eval experiment runner that wants apples-to-apples
 * cost numbers).
 */
const DEFAULT_BRIEFING_MODEL = 'claude-haiku-4-5';
const DEFAULT_FOLLOW_UP_MODEL = 'claude-sonnet-4-6';

const resolveModel = (
    override: string | undefined,
    taskEnvVar: string,
    fallbackModel: string,
): string => {
    if (override !== undefined) return override;
    const taskModel = process.env[taskEnvVar];
    if (taskModel !== undefined && taskModel.length > 0) return taskModel;
    return fallbackModel;
};

export const createAnthropicSynthesizer = (options?: {
    /**
     * If set, pins both the briefing and follow-up paths to this
     * single model. Used by tests and eval runners that want
     * apples-to-apples comparisons. Production omits this and lets
     * env vars route per task.
     */
    readonly model?: string;
    readonly apiKey?: string;
}): Synthesizer => {
    const briefingModel = resolveModel(
        options?.model,
        'ANTHROPIC_MODEL_BRIEFING',
        DEFAULT_BRIEFING_MODEL,
    );
    const followUpModel = resolveModel(
        options?.model,
        'ANTHROPIC_MODEL_FOLLOW_UP',
        DEFAULT_FOLLOW_UP_MODEL,
    );
    const apiKey = options?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('ANTHROPIC_API_KEY is required to build the default synthesizer');
    }

    const buildClient = (model: string) =>
        new ChatAnthropic({ model, apiKey, temperature: 0 }).withStructuredOutput(
            synthesisOutputSchema,
            { name: 'briefing_with_claim_ledger', includeRaw: true },
        );

    const briefingClient = buildClient(briefingModel);
    // Lazy: building the follow-up client also when briefing == follow-up
    // double-allocates two identical clients. Skip when models match.
    const followUpClient = followUpModel === briefingModel ? briefingClient : buildClient(followUpModel);

    return async ({ snapshot, envelope }) => {
        // §4.5: a free-text follow-up swaps both the system prompt and
        // the user-message wrapper. A `follow_up` task without a
        // `question` (a typed-suggestion follow-up planned for §4.1–4.4)
        // still uses the briefing prompt for now — those branches will
        // land their own prompts when those sub-phases ship.
        const question =
            envelope.task === 'follow_up' &&
            typeof envelope.question === 'string' &&
            envelope.question.length > 0
                ? envelope.question
                : null;
        const isFollowUp = question !== null;
        const systemPrompt = isFollowUp ? FOLLOW_UP_SYSTEM_PROMPT : SYSTEM_PROMPT;
        const userMessage = isFollowUp
            ? buildFollowUpUserMessage(snapshot, question)
            : buildUserMessage(snapshot);
        const structured = isFollowUp ? followUpClient : briefingClient;
        const model = isFollowUp ? followUpModel : briefingModel;
        const result = await structured.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userMessage),
        ]);
        const parsed = result.parsed;
        const raw = result.raw;
        const usageMeta = (raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
            .usage_metadata;
        const usage =
            usageMeta !== undefined
                ? {
                      model,
                      inputTokens: usageMeta.input_tokens ?? 0,
                      outputTokens: usageMeta.output_tokens ?? 0,
                  }
                : undefined;
        return {
            draft: { segments: parsed.segments },
            ledger: parsed.ledger,
            ...(usage !== undefined ? { usage } : {}),
        };
    };
};
