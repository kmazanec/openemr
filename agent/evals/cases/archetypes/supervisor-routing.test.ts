import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type {
    SupervisorDecide,
    SupervisorDeps,
} from '../../../src/graph/nodes/supervisor.js';
import { SUPERVISOR_ITERATION_CAP } from '../../../src/graph/nodes/supervisor.js';
import type {
    SupervisorDecision,
    SupervisorHandoff,
} from '../../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';
import { ARCHETYPES, type ArchetypeKey } from '../../fixtures/regenerate-archetypes.js';

import { baseEnvelope, buildClient, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §A.9 supervisor-routing eval cases. Per archetype: drive a default
 * briefing through the LLM-supervisor seam and assert plausibility
 * (not exact router behavior):
 *
 *   - Chosen handoff ∈ case's `allowedHandoffs: SupervisorHandoff[]`.
 *   - `supervisorIterations <= SUPERVISOR_ITERATION_CAP` on terminal
 *     state.
 *   - Every recorded decision carries a non-empty `reason`.
 *
 * `W2_ARCHITECTURE.md` §"Eval Architecture" pins this pattern: real-
 * model behavior changes between Anthropic releases, so per-MR Vitest
 * gates that pin one specific handoff become noise. The plausibility
 * rubric protects the contract (the LLM must pick a known handoff with
 * a rationale) while leaving the model free to choose between
 * equally-good options. Real-model coverage of the "right" choice
 * lives in the nightly LangSmith experiment, not here.
 *
 * Stub `decide` rather than calling Anthropic — per-MR cost balloons
 * and the test becomes nondeterministic. The stub mimics a model that
 * picks `synthesize` after seeing chart context, which is what the
 * default-briefing happy path expects on iteration 1.
 */

interface ArchetypeRoutingCase {
    readonly archetype: ArchetypeKey;
    readonly allowedHandoffs: readonly SupervisorHandoff[];
}

/**
 * For a default-briefing turn, the legitimate first-iteration handoffs
 * are `synthesize` (chart context already seeded by `retrieveChart`) or
 * the W2 retriever stubs `documentEvidenceRetriever` / `evidenceRetriever`
 * (Phase B/C will turn these from no-ops into real fetchers — picking
 * one today is plausible because the supervisor doesn't know they're
 * stubbed). `retrieveChart` is allowed too: a model might decide one
 * narrowing fetch is cheap and helpful before synthesizing. The
 * deterministic UC3/4.6.5/4.6.6 branches are explicitly NOT in the set
 * — the supervisor's prompt steers it away from those when the
 * envelope's `followUp.type` doesn't match.
 */
const DEFAULT_BRIEFING_ALLOWED: readonly SupervisorHandoff[] = [
    'synthesize',
    'retrieveChart',
    'documentEvidenceRetriever',
    'evidenceRetriever',
];

const ROUTING_CASES: readonly ArchetypeRoutingCase[] = ARCHETYPES.map((archetype) => ({
    archetype,
    allowedHandoffs: DEFAULT_BRIEFING_ALLOWED,
}));

/**
 * Stub supervisor that mimics a faithful first-iteration decision: it
 * sees chart context (callCount === 1) and picks `synthesize` with a
 * rationale that names the archetype. This is the deterministic path
 * the per-MR gate pins; the real model's freedom to pick another
 * `allowedHandoffs` value is exercised in the nightly experiment.
 */
const buildStubSupervisor = (archetype: ArchetypeKey): SupervisorDecide => {
    return vi.fn<SupervisorDecide>((input) => {
        const decision: SupervisorDecision = {
            handoff: 'synthesize',
            reason: `archetype=${archetype}; chart context observed (categories=${input.observation.chartCategoriesPresent.join(',')}); synthesizing default briefing`,
            narration: 'test narration',
        };
        return Promise.resolve(decision);
    });
};

describe.each(ROUTING_CASES)(
    'UC1 supervisor-routing — $archetype default briefing',
    ({ archetype, allowedHandoffs }) => {
        it('reaches a valid synthesize path within the iteration cap with a non-empty rationale on each decision', async () => {
            const snapshot = loadFixture(archetype);
            const client = buildClient(snapshot);
            const { synth } = buildFaithfulSynth();
            const supervisor: SupervisorDeps = { decide: buildStubSupervisor(archetype) };

            const graph = createBriefingGraph({
                retrieveChart: { client, token: 'eval-token', siteId: 'default' },
                supervisor,
                synthesize: { synthesizer: synth },
                verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            });

            const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

            // Plausibility: the chosen handoff (the one that terminates
            // the supervisor loop by routing to a non-supervisor edge)
            // is in the allowed set. We read the decision history's
            // last entry — that's the one the conditional-edge router
            // acted on.
            const history = out.supervisorDecisionHistory;
            expect(history.length).toBeGreaterThan(0);
            const terminal = history[history.length - 1];
            expect(terminal).toBeDefined();
            if (terminal === undefined) return;
            expect(allowedHandoffs).toContain(terminal.handoff);

            // Iteration cap structural invariant.
            expect(out.supervisorIterations).toBeLessThanOrEqual(SUPERVISOR_ITERATION_CAP);

            // Every recorded decision carries a non-empty rationale.
            for (const decision of history) {
                expect(decision.reason.length).toBeGreaterThan(0);
            }

            // Cap-hit must not have fired on the happy path.
            expect(out.capHit).toBe(false);

            // Sanity: the briefing actually ran end-to-end.
            expect(out.verified?.passed).toBe(true);
            expect(out.formatted).toBeDefined();
        });
    },
);
