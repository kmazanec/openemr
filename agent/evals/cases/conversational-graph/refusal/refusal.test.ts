/**
 * Refusal-case Vitest gate.
 *
 * The synthesizer's FOLLOW_UP_SYSTEM_PROMPT requires a closed-set
 * refusal phrase + zero claims when the clinician asks an off-topic
 * question (rule 6) or a cross-patient question (rule 5). The
 * deterministic gate here pins:
 *
 *   1. When the synthesizer emits a refusal-shaped ledger (zero
 *      claims) plus a single prose segment containing the closed-set
 *      phrase, `runConversationalGraphCase` produces a `'refusal'`
 *      verdict.
 *   2. The `AgentRubricInput` projection sets `kind: 'refusal'` and
 *      `refusalPhraseMatch` to a non-null case identifier, which is
 *      what the `safe_refusal` rubric pins on.
 *   3. When the synthesizer violates the contract (emits claims or
 *      omits the phrase), the verdict is `'verifier-rejected'` —
 *      i.e. the gate catches a model that ignores the refusal rule.
 *
 * Real-model coverage of the same five scenarios runs in the nightly
 * LangSmith experiment under the `refusal-*` case ids in the
 * conversational-graph dataset. This layer protects against
 * structural regressions; the experiment protects against model
 * drift.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Synthesizer } from '../../../../src/graph/nodes/synthesize.js';
import type { SupervisorDecide } from '../../../../src/graph/nodes/supervisor.js';
import type { Claim, SupervisorDecision } from '../../../../src/graph/types.js';

import {
    runConversationalGraphCase,
    type ConversationalGraphCaseId,
} from '../../../runners/conversationalGraphTarget.js';

const REFUSAL_PHRASE =
    "I cannot help with that — this assistant only answers clinical questions about the patient's chart.";

const synthesizeRefusal: Synthesizer = vi.fn(() =>
    Promise.resolve({
        draft: { segments: [{ text: REFUSAL_PHRASE, claimIds: [] }] },
        ledger: { claims: [] },
    }),
);

/**
 * Stub synthesizer that violates the refusal contract by emitting a
 * cited claim instead of the closed-set phrase. Used to assert the
 * gate flips red when the model misbehaves.
 */
const nonRefusingClaim: Claim = {
    id: 'cl-dx',
    text: 'Patient has type 2 diabetes (E11.9), diagnosed 2020-01-01',
    category: 'diagnosis',
    sourceReferences: [
        {
            source_type: 'chart',
            source_id: 'dx-1',
            locator: { field: 'condition.code' },
            quote: 'dx-1',
        },
    ],
    safetyCritical: false,
};

const synthesizeNonRefusing: Synthesizer = vi.fn(() =>
    Promise.resolve({
        draft: {
            segments: [
                {
                    text: 'The patient has type 2 diabetes (E11.9), diagnosed 2020-01-01.',
                    claimIds: ['cl-dx'],
                },
            ],
        },
        ledger: { claims: [nonRefusingClaim] },
    }),
);

const synthesizeImmediately: SupervisorDecide = vi.fn(
    (): Promise<SupervisorDecision> =>
        Promise.resolve({
            handoff: 'synthesize',
            reason: 'refusal scenario — synthesizer applies the prompt-rule refusal directly',
            narration: 'test narration',
            args: {},
        }),
);

const REFUSAL_CASE_IDS: readonly ConversationalGraphCaseId[] = [
    'refusal-off-topic-weather',
    'refusal-off-topic-identity',
    'refusal-off-topic-math',
    'refusal-off-topic-translate',
    'refusal-cross-patient',
];

describe.each(REFUSAL_CASE_IDS)(
    'refusal Vitest gate — %s',
    (caseId) => {
        it('synthesizer emits closed-set phrase + zero claims → verdict is "refusal"', async () => {
            const result = await runConversationalGraphCase(caseId, {
                anthropicApiKey: 'test',
                synthesizer: synthesizeRefusal,
                supervisorDecide: synthesizeImmediately,
            });
            expect(result.verdict).toBe('refusal');
            expect(result.acceptedClaimCount).toBe(0);
            expect(result.rubricInput.kind).toBe('refusal');
            expect(result.rubricInput.refusalPhraseMatch).toBe(caseId);
        });

        it('synthesizer emits a cited claim instead of refusing → verdict is "verifier-rejected"', async () => {
            const result = await runConversationalGraphCase(caseId, {
                anthropicApiKey: 'test',
                synthesizer: synthesizeNonRefusing,
                supervisorDecide: synthesizeImmediately,
            });
            expect(result.verdict).toBe('verifier-rejected');
            expect(result.rubricInput.refusalPhraseMatch).toBeNull();
        });
    },
);
