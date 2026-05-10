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
    retrieveChartArgs: null,    documentEvidenceArgs: null,    documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,    evidenceRetrieverArgs: null,    evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false, kickoffExtractionResults: [],
    ...overrides,
});

const decide = (decision: SupervisorDecision): SupervisorDecide => {
    return vi.fn(() => Promise.resolve(decision));
};

describe('createSupervisor (§A.7)', () => {
    it('happy path: routes to synthesize, increments iterations, records decision', async () => {
        const llm = decide({ handoff: 'synthesize', reason: 'chart context is sufficient', narration: 'test narration' });
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
            reason: 'need a wider lookback on labs', narration: 'test narration',
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
            reason: 'narrowing fetch', narration: 'test narration',
            args: { categories: [] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow(/categories/i);
    });

    it('rejects retrieveChart args naming an unknown category', async () => {
        const llm = decide({
            handoff: 'retrieveChart',
            reason: 'narrowing fetch', narration: 'test narration',
            args: { categories: ['vitals'] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow();
    });

    it('narrows documentEvidenceRetriever args (with defaults) into the documentEvidenceArgs slot', async () => {
        const llm = decide({
            handoff: 'documentEvidenceRetriever',
            reason: 'a recent lab artifact may answer this', narration: 'test narration',
            args: { query: 'recent A1c', doc_types: ['lab_pdf'] },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.supervisorDecisionHistory?.[0]?.handoff).toBe('documentEvidenceRetriever');
        expect(out.documentEvidenceArgs).toEqual({
            query: 'recent A1c',
            doc_types: ['lab_pdf'],
            // Schema defaults bind here — the architecture's 90/5.
            lookback_days: 90,
            top_k: 5,
        });
    });

    it('recovers documentEvidenceRetriever (missing query) on default_briefing kickoff via the chart-grounded fallback', async () => {
        // A bare default_briefing envelope (no typed question, no
        // pendingUploads) should not crash the graph just because the
        // model forgot to write args.query — by the time the supervisor
        // runs, retrieveChart has already populated state.snapshot, so
        // there is something coherent for the retriever to chase. The
        // fallback synthesises a generic guideline-shaped query for the
        // morning-prep case.
        const llm = decide({
            handoff: 'documentEvidenceRetriever',
            reason: 'forgot to set a query', narration: 'test narration',
            args: { doc_types: ['lab_pdf'] },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.documentEvidenceArgs?.query).toMatch(/guideline/i);
        expect(out.documentEvidenceArgs?.doc_types).toEqual(['lab_pdf']);
    });

    it('still rejects documentEvidenceRetriever (missing query) on a follow_up turn with no question and no uploads', async () => {
        // The fallback only fires for default_briefing. A follow_up
        // with neither a typed question nor uploads has nothing to
        // chase and must surface as a typed error.
        const llm = decide({
            handoff: 'documentEvidenceRetriever',
            reason: 'forgot to set a query', narration: 'test narration',
            args: { doc_types: ['lab_pdf'] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(
            supervisor(baseState({ envelope: { ...envelope, task: 'follow_up' } })),
        ).rejects.toThrow(/query/i);
    });

    it('rejects documentEvidenceRetriever args with empty doc_types (Zod min(1))', async () => {
        const llm = decide({
            handoff: 'documentEvidenceRetriever',
            reason: 'pathological narrowing', narration: 'test narration',
            args: { query: 'whatever', doc_types: [] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow();
    });

    it('§C.3: narrows evidenceRetriever args (with defaults) into the evidenceRetrieverArgs slot', async () => {
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'screening guideline likely relevant', narration: 'test narration',
            args: { query: 'USPSTF colorectal cancer screening' },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.supervisorDecisionHistory?.[0]?.handoff).toBe('evidenceRetriever');
        expect(out.evidenceRetrieverArgs).toEqual({
            query: 'USPSTF colorectal cancer screening',
            // Schema default — top-5 after rerank (bumped from 3 to give
            // the synthesizer more recommendation surface area).
            top_k: 5,
        });
    });

    it('§C.3: passes evidenceRetriever source_filter through to the slot', async () => {
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'restrict to USPSTF', narration: 'test narration',
            args: {
                query: 'colorectal screening',
                top_k: 5,
                source_filter: ['USPSTF'],
            },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.evidenceRetrieverArgs).toEqual({
            query: 'colorectal screening',
            top_k: 5,
            source_filter: ['USPSTF'],
        });
    });

    it('§C.3: recovers evidenceRetriever (missing query) on default_briefing kickoff via the chart-grounded fallback', async () => {
        // Mirrors the documentEvidenceRetriever recovery test above —
        // see that test for why the morning-prep no-question path
        // fills in a synthesised query rather than throwing. This is
        // the case the prod failure on patient pid 109 surfaced.
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'forgot to set a query', narration: 'test narration',
            args: { top_k: 3 },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.evidenceRetrieverArgs?.query).toMatch(/guideline/i);
        expect(out.evidenceRetrieverArgs?.top_k).toBe(3);
    });

    it('§C.3: still rejects evidenceRetriever (missing query) on a follow_up turn with no question and no uploads', async () => {
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'forgot to set a query', narration: 'test narration',
            args: { top_k: 3 },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(
            supervisor(baseState({ envelope: { ...envelope, task: 'follow_up' } })),
        ).rejects.toThrow(/query/i);
    });

    it('§C.3: rejects evidenceRetriever args with empty source_filter (Zod min(1))', async () => {
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'pathological narrowing', narration: 'test narration',
            args: { query: 'A1c targets', source_filter: [] },
        });
        const supervisor = createSupervisor({ decide: llm });

        await expect(supervisor(baseState())).rejects.toThrow();
    });

    it('§C.3: rejects evidenceRetriever args with top_k beyond bounds', async () => {
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'over-fetching', narration: 'test narration',
            args: { query: 'A1c', top_k: 999 },
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
            reason: 'should not be called once cap is reached', narration: 'test narration',
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
            reason: 'needs guideline context', narration: 'test narration',
            args: { query: 'A1c targets' },
        };
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'still need guideline context', narration: 'test narration',
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

    it('observation surfaces pendingUploads and kickoffExtractionResults so the LLM can route correctly', async () => {
        const observed: unknown[] = [];
        const llm: SupervisorDecide = vi.fn<SupervisorDecide>((input) => {
            observed.push(input.observation);
            return Promise.resolve({
                handoff: 'kickoffExtraction',
                reason: 'document attached and not yet extracted',
                narration: 'Analyzing the lipid panel you just attached.',
                args: { document_uuid: 'doc-1', doc_type: 'lab_pdf' },
            } as SupervisorDecision);
        });
        const supervisor = createSupervisor({ decide: llm });

        await supervisor(baseState({
            envelope: {
                ...envelope,
                task: 'follow_up',
                pendingUploads: [{ documentUuid: 'doc-1', docType: 'lab_pdf', canonicalExt: 'pdf' }],
            },
        }));

        const obs = observed[0] as {
            pendingUploads: readonly { documentUuid: string; docType: string }[];
            kickoffExtractionResultsThisTurn: readonly unknown[];
        };
        // The observation deliberately omits `canonicalExt` —
        // the model doesn't need the storage extension to route, and
        // keeping the supervisor prompt narrow keeps the supervisor's
        // attention on the routing decision. The kickoffExtraction
        // node looks up canonicalExt from the envelope's pendingUploads
        // entry directly.
        expect(obs.pendingUploads).toEqual([
            { documentUuid: 'doc-1', docType: 'lab_pdf' },
        ]);
        expect(obs.kickoffExtractionResultsThisTurn).toEqual([]);
    });

    it('observation reflects kickoffExtractionResults appended this turn so the LLM does not re-extract', async () => {
        const observed: unknown[] = [];
        const llm: SupervisorDecide = vi.fn<SupervisorDecide>((input) => {
            observed.push(input.observation);
            return Promise.resolve({
                handoff: 'synthesize',
                reason: 'extraction complete; ready to summarize',
                narration: 'Drafting your briefing.',
            } as SupervisorDecision);
        });
        const supervisor = createSupervisor({ decide: llm });

        await supervisor(baseState({
            envelope: {
                ...envelope,
                task: 'follow_up',
                pendingUploads: [{ documentUuid: 'doc-1', docType: 'lab_pdf', canonicalExt: 'pdf' }],
            },
            kickoffExtractionResults: [
                {
                    documentUuid: 'doc-1',
                    docType: 'lab_pdf',
                    status: 'persisted',
                    artifactId: 'a-1',
                    errorCode: null,
                    idempotencyHit: false,
                },
            ],
        }));

        const obs = observed[0] as {
            pendingUploads: readonly { documentUuid: string }[];
            kickoffExtractionResultsThisTurn: readonly { documentUuid: string; status: string }[];
        };
        expect(obs.pendingUploads).toEqual([
            { documentUuid: 'doc-1', docType: 'lab_pdf' },
        ]);
        expect(obs.kickoffExtractionResultsThisTurn).toEqual([
            { documentUuid: 'doc-1', status: 'persisted' },
        ]);
    });

    it('observation projects an implicitQuestion when uploads arrive without a typed question', async () => {
        const observed: unknown[] = [];
        const llm: SupervisorDecide = vi.fn<SupervisorDecide>((input) => {
            observed.push(input.observation);
            return Promise.resolve({
                handoff: 'kickoffExtraction',
                reason: 'pending upload',
                narration: 'Analyzing the lab.',
                args: { document_uuid: 'doc-1', doc_type: 'lab_pdf' },
            } as SupervisorDecision);
        });
        const supervisor = createSupervisor({ decide: llm });

        await supervisor(baseState({
            envelope: {
                ...envelope,
                task: 'follow_up',
                pendingUploads: [{ documentUuid: 'doc-1', docType: 'lab_pdf', canonicalExt: 'pdf' }],
                // No `question` field — upload-only turn.
            },
        }));

        const obs = observed[0] as { question: string | null; implicitQuestion: string | null };
        expect(obs.question).toBeNull();
        expect(obs.implicitQuestion).not.toBeNull();
        // The implicit question is keyed off the doc type — lab uploads
        // get a "what does this tell us, what should I consider doing"
        // phrasing that triggers the supervisor's existing
        // guideline-routing rule.
        expect(obs.implicitQuestion).toContain('lab');
        expect(obs.implicitQuestion?.toLowerCase()).toContain('guideline');
    });

    it('observation prefers explicit question over implicit when both could apply', async () => {
        const observed: unknown[] = [];
        const llm: SupervisorDecide = vi.fn<SupervisorDecide>((input) => {
            observed.push(input.observation);
            return Promise.resolve({
                handoff: 'synthesize',
                reason: 'explicit question wins',
                narration: 'Answering your question.',
            } as SupervisorDecision);
        });
        const supervisor = createSupervisor({ decide: llm });

        await supervisor(baseState({
            envelope: {
                ...envelope,
                task: 'follow_up',
                question: 'Should we increase metformin?',
                pendingUploads: [{ documentUuid: 'doc-1', docType: 'lab_pdf', canonicalExt: 'pdf' }],
            },
        }));

        const obs = observed[0] as { question: string | null; implicitQuestion: string | null };
        expect(obs.question).toBe('Should we increase metformin?');
        expect(obs.implicitQuestion).toBeNull();
    });

    it('honors a non-kickoff routing choice on a follow-up turn with an explicit question + chart-side pendingUploads', async () => {
        // Regression: chart-side documents enriched by the briefing
        // runner re-appear in `envelope.pendingUploads` on every follow-
        // up turn. When the user asks an explicit question that does
        // not reference those documents, the supervisor must be free to
        // route the question through evidenceRetriever / synthesize
        // instead of being forced into kickoffExtraction. The node
        // honors whatever decision the LLM (steered by the prompt)
        // returns; it does not second-guess `handoff: 'synthesize'`
        // when pendingUploads is non-empty.
        const llm = decide({
            handoff: 'synthesize',
            reason: 'explicit follow-up question — answering directly',
            narration: 'Answering your question.',
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState({
            envelope: {
                ...envelope,
                task: 'follow_up',
                question: 'Why was Metformin prescribed?',
                pendingUploads: [
                    { documentUuid: 'chart-doc-1', docType: 'intake_form', canonicalExt: 'pdf' },
                ],
            },
            kickoffExtractionResults: [],
        }));

        expect(out.supervisorDecisionHistory?.at(-1)?.handoff).toBe('synthesize');
    });

    it('observation has null implicitQuestion when there are no pending uploads', async () => {
        const observed: unknown[] = [];
        const llm: SupervisorDecide = vi.fn<SupervisorDecide>((input) => {
            observed.push(input.observation);
            return Promise.resolve({
                handoff: 'synthesize',
                reason: 'no uploads, no question',
                narration: 'Drafting your briefing.',
            } as SupervisorDecision);
        });
        const supervisor = createSupervisor({ decide: llm });

        await supervisor(baseState());

        const obs = observed[0] as { implicitQuestion: string | null };
        expect(obs.implicitQuestion).toBeNull();
    });

    it('records narration on each appended decision so the runner can forward it as an SSE event', async () => {
        const llm = decide({
            handoff: 'evidenceRetriever',
            reason: 'guideline-shaped question',
            narration: 'Checking the USPSTF on statin primary prevention.',
            args: { query: 'statin primary prevention' },
        });
        const supervisor = createSupervisor({ decide: llm });

        const out = await supervisor(baseState());

        expect(out.supervisorDecisionHistory).toHaveLength(1);
        const latest = out.supervisorDecisionHistory?.at(-1);
        expect(latest?.narration).toBe('Checking the USPSTF on statin primary prevention.');
    });
});
