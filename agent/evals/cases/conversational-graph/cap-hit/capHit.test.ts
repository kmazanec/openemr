/**
 * Cap-hit forced-synthesize evals driven by genuinely-empty retrievers.
 *
 * The architecture pins iteration cap as a structural backstop: at
 * iteration N === cap, the supervisor short-circuits to a forced
 * `synthesize` handoff with `capHit: true` and the LLM is not called
 * again. These cases exercise the architecturally-honest production-
 * incident shape — a retriever that returns empty turn after turn,
 * a supervisor that doesn't react and re-picks the same handoff, and
 * the cap as the only path to termination.
 *
 * Two scenarios:
 *  - empty document-evidence store: supervisor sticks on
 *    `documentEvidenceRetriever`; cap binds; forced synthesize fires;
 *    response renders.
 *  - empty Pinecone result: supervisor sticks on `evidenceRetriever`;
 *    cap binds; same backstop.
 *
 * `iterationCap` is overridden to a small number so each test runs
 * within langgraph's default `recursionLimit` (25). The cap-hit logic
 * is cap-agnostic, so a smaller value pins the same architectural
 * guarantee at lower cost.
 */

import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../../src/graph/index.js';
import type {
    SupervisorDecide,
    SupervisorDeps,
} from '../../../../src/graph/nodes/supervisor.js';
import type { Synthesizer } from '../../../../src/graph/nodes/synthesize.js';
import type {
    Claim,
    ClaimLedger,
    DraftBriefing,
    SupervisorDecision,
    SupervisorHandoff,
} from '../../../../src/graph/types.js';
import type { PineconeRetriever } from '../../../../src/retrievers/pinecone.js';
import type { CohereRerankClient } from '../../../../src/retrievers/cohere.js';
import type { ChartSnapshot } from '../../../../src/snapshot/types.js';
import type { SnapshotClient } from '../../../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../../../src/verify/unverifiedClaimsLog.js';

import {
    PID,
    baseEnvelope,
    baseSnapshot,
    chartRef,
} from '../_helpers.js';

const CAP = 3;

const buildSnapshotClient = (): SnapshotClient => {
    const snap = baseSnapshot({
        diagnoses: [
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes without complications',
                onsetDate: '2020-01-01',
                source: chartRef('dx-1', 'condition.code'),
            },
        ],
    });
    const chart: ChartSnapshot = {
        patient: snap.patient,
        appointment: snap.appointment,
        diagnoses: snap.diagnoses,
        prescriptions: snap.prescriptions,
        allergies: snap.allergies,
        labs: [],
        encounters: [],
        reminders: [],
        medications: [],
    };
    return { fetchSnapshot: vi.fn(() => Promise.resolve(chart)) };
};

const buildEmptyPinecone = (): PineconeRetriever => ({
    isEmpty: false,
    query: vi.fn(() => Promise.resolve([])),
});

const buildEmptyCohere = (): CohereRerankClient => ({
    rerank: vi.fn(() => Promise.resolve([])),
});

const buildEmptyDocumentStore = () => ({
    searchArtifacts: vi.fn(() => Promise.resolve([] as const)),
});

/**
 * Supervisor stub that always picks the same retriever handoff. The
 * retriever returns empty; the stub doesn't react and re-picks; the
 * cap is the only termination path.
 */
const stickyRetrieverSupervisor = (
    handoff: 'documentEvidenceRetriever' | 'evidenceRetriever',
): SupervisorDecide => {
    return vi.fn<SupervisorDecide>(() => {
        const decision: SupervisorDecision = {
            handoff: handoff satisfies SupervisorHandoff,
            reason: `pathological stub: keep asking ${handoff} despite empty results`,
            narration: 'test narration',
            args:
                handoff === 'documentEvidenceRetriever'
                    ? { query: 'HbA1c', lookback_days: 90, top_k: 5 }
                    : { query: 'colorectal screening guidance', top_k: 3 },
        };
        return Promise.resolve(decision);
    });
};

const buildSynthesizer = (
    ledger: ClaimLedger,
    draft: DraftBriefing,
): { readonly synth: Synthesizer; readonly mock: ReturnType<typeof vi.fn> } => {
    const mock = vi.fn(() => Promise.resolve({ draft, ledger }));
    return { synth: mock, mock };
};

interface CapHitScenario {
    readonly id: string;
    readonly description: string;
    readonly stickyHandoff: 'documentEvidenceRetriever' | 'evidenceRetriever';
}

const SCENARIOS: readonly CapHitScenario[] = [
    {
        id: 'empty-document-evidence',
        description:
            'Document evidence store has no artifacts for this patient; supervisor keeps asking; cap binds.',
        stickyHandoff: 'documentEvidenceRetriever',
    },
    {
        id: 'empty-evidence-retriever',
        description:
            'Pinecone returns zero hits; supervisor keeps asking; cap binds.',
        stickyHandoff: 'evidenceRetriever',
    },
];

describe.each(SCENARIOS)('cap-hit with empty retrievers — $id', (scenario) => {
    it('cap binds, forced synthesize fires, and the briefing still renders', async () => {
        const snapshotClient = buildSnapshotClient();
        const documentStore = buildEmptyDocumentStore();
        const pinecone = buildEmptyPinecone();
        const cohere = buildEmptyCohere();

        // Forced-synthesize path produces a chart-grounded fallback
        // ledger — the shape the real synthesizer would emit when no
        // retrievers fed it. The Vitest layer doesn't model the real
        // synthesizer; the LangSmith experiment does.
        const claims: readonly Claim[] = [
            {
                id: 'cl-dx',
                text: 'Active diagnosis: Type 2 diabetes (E11.9)',
                category: 'diagnosis',
                sourceReferences: [chartRef('dx-1', 'condition.code')],
                safetyCritical: false,
            },
        ];
        const ledger: ClaimLedger = { claims };
        const draft: DraftBriefing = {
            segments: [
                {
                    text: 'No new evidence retrieved this turn; chart context only.',
                    claimIds: [],
                },
                ...claims.map((c) => ({ text: c.text, claimIds: [c.id] })),
            ],
        };
        const { synth, mock: synthMock } = buildSynthesizer(ledger, draft);

        const supervisor: SupervisorDeps = {
            decide: stickyRetrieverSupervisor(scenario.stickyHandoff),
            iterationCap: CAP,
        };

        const graph = createBriefingGraph({
            retrieveChart: { client: snapshotClient, token: 'eval-token', siteId: 'default' },
            supervisor,
            documentEvidenceRetriever: { store: documentStore },
            evidenceRetriever: { pineconeRetriever: pinecone, cohereRerank: cohere },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({
            envelope: baseEnvelope({ patient: { pid: PID, uuid: 'p-1' } }),
        });

        // Cap-hit fired and the supervisor stub was called exactly
        // `CAP` times — once per iteration before the cap bound. The
        // forced synthesize did NOT call decide() again.
        expect(out.capHit).toBe(true);
        expect(supervisor.decide).toHaveBeenCalledTimes(CAP);

        // Decision history: CAP supervisor picks + 1 forced synthesize.
        const history = out.supervisorDecisionHistory;
        expect(history).toHaveLength(CAP + 1);
        const terminal = history[history.length - 1];
        expect(terminal?.handoff).toBe('synthesize');
        expect(terminal?.reason).toMatch(/cap/i);

        // Synthesizer ran exactly once via the forced path.
        expect(synthMock).toHaveBeenCalledTimes(1);

        // Briefing rendered end-to-end. The clinician sees segments,
        // not a stack trace.
        const formatted = out.formatted;
        expect(formatted).toBeDefined();
        if (formatted === null || formatted === undefined) return;
        expect(formatted.segments.length).toBeGreaterThan(0);
        expect(Array.isArray(formatted.gaps)).toBe(true);
    });
});
