import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type {
    SupervisorDecide,
    SupervisorDeps,
} from '../../../src/graph/nodes/supervisor.js';
import type { SupervisorDecision } from '../../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildClient, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §A.9 cap-hit forced-synthesize regression case. Mirrors
 * `W2_ARCHITECTURE.md` §"Iteration cap: 10": when the supervisor
 * never picks `synthesize` (a degenerate sequence the model itself
 * cannot escape), the architecture's structural backstop must:
 *
 *   - bind at iteration N === cap with `capHit: true`,
 *   - force a terminal `synthesize` handoff WITHOUT calling the LLM
 *     again,
 *   - still produce a verified, formatted briefing so the clinician
 *     sees something rather than a stack trace.
 *
 * The pathological state is modeled by a stub `decide` that always
 * picks a supervisor-looping handoff (`evidenceRetriever`, a Phase A
 * no-op stub that returns control to the supervisor). With nothing
 * advancing the state and `synthesize` never chosen voluntarily, the
 * cap is the only path to termination.
 *
 * `iterationCap` is overridden to a small number so the test runs
 * within langgraph's default `recursionLimit` (25) — production cap=10
 * doesn't fit comfortably under 25 because every supervisor iteration
 * also burns one node-step on the looping stub. The cap-hit logic is
 * cap-agnostic, so a smaller value pins the same architectural
 * guarantee at lower cost.
 */

const CAP = 3;

const buildLoopingStubSupervisor = (): SupervisorDecide => {
    return vi.fn<SupervisorDecide>(() => {
        const decision: SupervisorDecision = {
            handoff: 'evidenceRetriever',
            reason: 'pathological stub: always asks for more guideline evidence',
            args: { query: 'evidence forever' },
        };
        return Promise.resolve(decision);
    });
};

describe('UC1 cap-hit — pathological supervisor never picks synthesize', () => {
    it('cap binds, forces synthesize without another LLM call, and the briefing still renders', async () => {
        const snapshot = loadFixture('diabetic');
        const client = buildClient(snapshot);
        const { synth: faithfulSynth } = buildFaithfulSynth();

        const decide = buildLoopingStubSupervisor();
        const supervisor: SupervisorDeps = {
            decide,
            iterationCap: CAP,
        };

        const graph = createBriefingGraph({
            retrieveChart: { client, token: 'eval-token', siteId: 'default' },
            supervisor,
            synthesize: { synthesizer: faithfulSynth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

        // Cap-hit flag is the contract surface the eval pins.
        expect(out.capHit).toBe(true);

        // The supervisor invoked the LLM exactly `cap` times — once per
        // iteration before the cap bound. The cap-hit path forces
        // synthesize without another `decide()` call.
        expect(decide).toHaveBeenCalledTimes(CAP);

        // The terminal decision is a forced `synthesize` with the
        // architecture's pinned reason ("iteration cap reached — ...").
        const history = out.supervisorDecisionHistory;
        expect(history.length).toBe(CAP + 1);
        const terminal = history[history.length - 1];
        expect(terminal?.handoff).toBe('synthesize');
        expect(terminal?.reason).toMatch(/cap/i);

        // The briefing still rendered end-to-end. The verifier passes
        // because the faithful synthesizer's ledger matches the
        // snapshot — even on the pathological path the clinician sees
        // a usable response, not an error.
        expect(out.verified).toBeDefined();
        expect(out.verified?.passed).toBe(true);
        expect(out.formatted).toBeDefined();
        expect(out.formatted?.segments.length).toBeGreaterThan(0);
    });
});
