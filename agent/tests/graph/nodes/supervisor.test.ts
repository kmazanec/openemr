import { describe, expect, it, vi } from 'vitest';

import {
    SUPERVISOR_ITERATION_CAP,
    type SupervisorDecide,
    createSupervisor,
} from '../../../src/graph/nodes/supervisor.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type {
    BriefingSnapshot,
    RequestEnvelope,
    SupervisorDecision,
} from '../../../src/graph/types.js';

const PID = 42;

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'default_briefing',
};

const sourceRef = (id: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field },
    quote: id,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: sourceRef('42', 'patient.name'),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
};

const baseState = (overrides: Partial<BriefingState> = {}): BriefingState => ({
    envelope,
    priorTurnContext: { turns: [] },
    snapshot,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 1,
    retrieveChartArgs: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false,
    ...overrides,
});

const decide = (decision: SupervisorDecision): SupervisorDecide => {
    return vi.fn(() => Promise.resolve(decision));
};

describe('createSupervisor (§A.7)', () => {
    it('happy path: routes to synthesize, increments iterations, records decision', async () => {
        const llm = decide({ handoff: 'synthesize', reason: 'chart context is sufficient' });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.supervisorIterations).toBe(1);
        expect(out.supervisorDecisionHistory).toHaveLength(1);
        expect(out.supervisorDecisionHistory?.[0]?.handoff).toBe('synthesize');
        // The supervisor leaves capHit untouched on the non-cap path —
        // the state-channel default (false) wins. Asserting "not true"
        // documents that intent without depending on the LastValue
        // mechanic.
        expect(out.capHit ?? false).toBe(false);
        expect(out.retrieveChartArgs).toBeUndefined();
    });

    it('routes retrieveChart with structured args into the retrieveChartArgs slot', async () => {
        const llm = decide({
            handoff: 'retrieveChart',
            reason: 'need a wider lookback on labs',
            args: { categories: ['lab'] },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState({ retrieveChartCallCount: 1 }));

        expect(out.supervisorDecisionHistory?.[0]?.handoff).toBe('retrieveChart');
        expect(out.retrieveChartArgs).toEqual({ categories: ['lab'] });
    });

    it('rejects malformed retrieveChart args (empty categories) before they reach state', async () => {
        const llm = decide({
            handoff: 'retrieveChart',
            reason: 'narrowing fetch',
            args: { categories: [] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow(/categories/i);
    });

    it('rejects retrieveChart args naming an unknown category', async () => {
        const llm = decide({
            handoff: 'retrieveChart',
            reason: 'narrowing fetch',
            args: { categories: ['vitals'] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow();
    });

    it('cap-hit: forces synthesize and sets capHit when iterations reach the cap', async () => {
        // The supervisor never calls the LLM here — the iteration cap
        // binds before any decision is made and the graph forces a
        // terminal synthesize handoff.
        const llm = decide({
            handoff: 'retrieveChart',
            reason: 'should not be called once cap is reached',
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(
            baseState({ supervisorIterations: SUPERVISOR_ITERATION_CAP }),
        );

        expect(llm).not.toHaveBeenCalled();
        expect(out.capHit).toBe(true);
        const last = out.supervisorDecisionHistory?.at(-1);
        expect(last?.handoff).toBe('synthesize');
        expect(last?.reason).toMatch(/cap/i);
    });

    it('cycle detection: re-picking the same handoff with no new state emits a warning but does not terminate', async () => {
        const warn = vi.fn();
        const previous: SupervisorDecision = {
            handoff: 'evidenceRetriever',
            reason: 'needs guideline context',
            args: { query: 'A1c targets' },
        };
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'still need guideline context',
            args: { query: 'A1c targets' },
        });
        const supervisor = createSupervisor({
            decide: llm,
            onCycleWarning: warn,
        });

        const out = await supervisor(
            baseState({
                supervisorIterations: 2,
                supervisorDecisionHistory: [previous],
            }),
        );

        expect(warn).toHaveBeenCalledTimes(1);
        expect(out.supervisorIterations).toBe(3);
        expect(out.capHit ?? false).toBe(false);
        expect(out.supervisorDecisionHistory).toHaveLength(2);
    });

    it('propagates structured-output validation failures from the LLM (typed error, not graph state)', async () => {
        // `withStructuredOutput` would normally reject malformed model
        // output before it reaches the supervisor; the supervisor must
        // surface the error rather than coerce around it. We model that
        // by having `decide` itself throw — exactly what
        // `withStructuredOutput` does on a parse failure after the
        // built-in retry budget is exhausted.
        const llm: SupervisorDecide = vi.fn(() =>
            Promise.reject(new Error('structured output parse failed')),
        );
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow(
            /structured output parse failed/,
        );
    });
});
