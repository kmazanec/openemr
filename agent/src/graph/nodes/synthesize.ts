import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import type { BriefingState, BriefingStateUpdate } from '../state.js';
import { SYSTEM_PROMPT, buildUserMessage } from '../synthesize.prompt.js';
import type { BriefingSnapshot, ClaimLedger } from '../types.js';

/**
 * Zod schema for the structured claim ledger the model must emit.
 * Mirrors `Claim` / `ClaimLedger` in `types.ts`. `withStructuredOutput`
 * coerces the model into this shape and retries on a malformed parse,
 * giving us strict-JSON behavior without hand-rolled repair logic.
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

const synthesisOutputSchema = z.object({
    draft: z
        .string()
        .min(1)
        .describe('Free-text briefing the physician will read. Must follow the fixed structure.'),
    ledger: z
        .object({
            claims: z.array(claimSchema),
        })
        .describe('Every factual claim in `draft`, with the source records that back it.'),
});

export type Synthesizer = (input: {
    snapshot: BriefingSnapshot;
}) => Promise<{ draft: string; ledger: ClaimLedger }>;

export interface SynthesizeDeps {
    readonly synthesizer: Synthesizer;
}

export const createSynthesize = (
    deps: SynthesizeDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    return async (state) => {
        if (state.snapshot === null) {
            throw new Error('Synthesize called before Retrieve populated the snapshot');
        }
        const { draft, ledger } = await deps.synthesizer({ snapshot: state.snapshot });
        return { draft, claimLedger: ledger };
    };
};

/**
 * Default `Synthesizer` backed by ChatAnthropic + structured output.
 * The model is read from `ANTHROPIC_MODEL` env (default
 * `claude-sonnet-4-5-20250929`). Strict JSON via
 * `withStructuredOutput(zodSchema)` — LangChain handles JSON-coercion
 * and retry-on-parse-error.
 */
export const createAnthropicSynthesizer = (options?: {
    readonly model?: string;
    readonly apiKey?: string;
}): Synthesizer => {
    const model = options?.model ?? process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-5-20250929';
    const apiKey = options?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('ANTHROPIC_API_KEY is required to build the default synthesizer');
    }
    const llm = new ChatAnthropic({ model, apiKey, temperature: 0 });
    const structured = llm.withStructuredOutput(synthesisOutputSchema, {
        name: 'briefing_with_claim_ledger',
    });

    return async ({ snapshot }) => {
        const out = await structured.invoke([
            new SystemMessage(SYSTEM_PROMPT),
            new HumanMessage(buildUserMessage(snapshot)),
        ]);
        return { draft: out.draft, ledger: out.ledger };
    };
};
