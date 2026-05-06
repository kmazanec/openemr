/**
 * Multi-retriever-turn evals.
 *
 * Drives the briefing graph through a turn that genuinely needs both
 * `documentEvidenceRetriever` and `evidenceRetriever`, asserting:
 *  1. The supervisor invokes both retrievers within the iteration cap
 *     (no degenerate loop, no early bail).
 *  2. Every recorded supervisor decision carries a non-empty rationale
 *     (the architecture's plausibility rubric for routing).
 *  3. The verified ledger contains both an `extracted_document` claim
 *     and a `guideline` claim — `format` then groups them into the
 *     panel's document and guideline sections.
 *
 * The supervisor is a scripted stub. The plausibility-routing surface
 * (whether the real model picks both retrievers given the question
 * shape) is exercised by the nightly LangSmith experiment; this layer
 * pins what happens *given* the model picked the load-bearing
 * sequence.
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
import type {
    PineconeHybridHit,
    PineconeRetriever,
} from '../../../../src/retrievers/pinecone.js';
import type {
    CohereRerankClient,
    CohereRerankResult,
} from '../../../../src/retrievers/cohere.js';
import type { ChartSnapshot } from '../../../../src/snapshot/types.js';
import type { SnapshotClient } from '../../../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../../../src/verify/unverifiedClaimsLog.js';

import {
    COLORECTAL_CHUNK,
    PID,
    baseEnvelope,
    baseSnapshot,
    chartRef,
    extractedDocRef,
    factSnippet,
    guidelineSnippet,
    guidelineSourceRef,
    labArtifact,
} from '../_helpers.js';

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

interface PineconeRig {
    readonly retriever: PineconeRetriever;
    readonly queryMock: ReturnType<typeof vi.fn>;
}

const buildScriptedPinecone = (): PineconeRig => {
    const hit: PineconeHybridHit = {
        id: COLORECTAL_CHUNK.chunkId,
        score: 0.92,
        publication: COLORECTAL_CHUNK.publication,
        year: COLORECTAL_CHUNK.year,
        section: COLORECTAL_CHUNK.section,
        section_label: COLORECTAL_CHUNK.title,
        title: COLORECTAL_CHUNK.title,
        url: COLORECTAL_CHUNK.url,
        license_tier: COLORECTAL_CHUNK.licenseTier,
        chunk_text: COLORECTAL_CHUNK.quote,
    };
    const queryMock = vi.fn(() => Promise.resolve([hit]));
    return {
        retriever: { isEmpty: false, query: queryMock },
        queryMock,
    };
};

const buildScriptedCohere = (): CohereRerankClient => ({
    rerank: vi.fn((input: { readonly documents: readonly string[] }): Promise<readonly CohereRerankResult[]> => {
        const out: CohereRerankResult[] = input.documents.map((_doc: string, i: number) => ({
            index: i,
            relevanceScore: 0.97,
        }));
        return Promise.resolve(out);
    }),
});

interface ScriptedDecision {
    readonly handoff: SupervisorHandoff;
    readonly reason: string;
    readonly args?: Record<string, unknown>;
}

const scriptedSupervisor = (sequence: readonly ScriptedDecision[]): SupervisorDecide => {
    let i = 0;
    return vi.fn<SupervisorDecide>(() => {
        const next = sequence[i];
        i += 1;
        const decision: SupervisorDecision = next === undefined
            ? {
                  handoff: 'synthesize',
                  reason: 'fallback synthesize after scripted sequence exhausted',
                  narration: 'test narration',
              }
            : {
                  handoff: next.handoff,
                  reason: next.reason,
                  narration: 'test narration',
                  ...(next.args !== undefined ? { args: next.args } : {}),
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

interface MultiRetrieverScenario {
    readonly id: string;
    readonly description: string;
    readonly sequence: readonly ScriptedDecision[];
}

const QUERY = 'colorectal screening guidance after a recent A1c result';

const SCENARIOS: readonly MultiRetrieverScenario[] = [
    {
        id: 'evidence-then-document',
        description:
            'Supervisor routes to evidenceRetriever first, then documentEvidenceRetriever, then synthesize.',
        sequence: [
            {
                handoff: 'evidenceRetriever',
                reason: 'fetch USPSTF guidance for the question',
                args: { query: QUERY, top_k: 3 },
            },
            {
                handoff: 'documentEvidenceRetriever',
                reason: 'ground the lab claim in the recent extracted document',
                args: { query: 'HbA1c', lookback_days: 90, top_k: 5 },
            },
            {
                handoff: 'synthesize',
                reason: 'both retrievers returned snippets; produce briefing',
            },
        ],
    },
    {
        id: 'document-then-evidence',
        description:
            'Supervisor routes to documentEvidenceRetriever first, then evidenceRetriever, then synthesize.',
        sequence: [
            {
                handoff: 'documentEvidenceRetriever',
                reason: 'pull the lab fact snippet before deciding which guideline to fetch',
                args: { query: 'HbA1c', lookback_days: 90, top_k: 5 },
            },
            {
                handoff: 'evidenceRetriever',
                reason: 'A1c suggests adding screening context; fetch USPSTF guidance',
                args: { query: QUERY, top_k: 3 },
            },
            {
                handoff: 'synthesize',
                reason: 'document + guideline context in hand; synthesize',
            },
        ],
    },
    {
        id: 'document-evidence-document-synthesize',
        description:
            'Supervisor probes the document, then guidelines, then re-checks the document, then synthesizes.',
        sequence: [
            {
                handoff: 'documentEvidenceRetriever',
                reason: 'first look at recent extracted facts',
                args: { query: 'HbA1c', lookback_days: 90, top_k: 5 },
            },
            {
                handoff: 'evidenceRetriever',
                reason: 'fetch matching guideline',
                args: { query: QUERY, top_k: 3 },
            },
            {
                handoff: 'documentEvidenceRetriever',
                reason: 're-narrow document scope after seeing the guideline',
                args: { query: 'HbA1c', lookback_days: 90, top_k: 5 },
            },
            {
                handoff: 'synthesize',
                reason: 'evidence in hand; synthesize',
            },
        ],
    },
];

describe.each(SCENARIOS)('multi-retriever turn — $id', (scenario) => {
    it('invokes both retrievers within the cap and the assistant message cites both source types', async () => {
        const snapshotClient = buildSnapshotClient();
        const pineconeRig = buildScriptedPinecone();
        const cohere = buildScriptedCohere();

        const labFact = factSnippet({
            artifactId: labArtifact().artifactId,
            documentUuid: labArtifact().documentUuid,
        });
        const guideline = guidelineSnippet();
        const claims: readonly Claim[] = [
            {
                id: 'cl-dx',
                text: 'Active diagnosis: Type 2 diabetes (E11.9)',
                category: 'diagnosis',
                sourceReferences: [chartRef('dx-1', 'condition.code')],
                safetyCritical: false,
            },
            {
                id: 'cl-lab',
                text: 'HbA1c was 6.4 % on the recent lab',
                category: 'lab',
                sourceReferences: [extractedDocRef(labFact, 'HbA1c 6.4')],
                safetyCritical: false,
            },
            {
                id: 'cl-guide',
                text: 'USPSTF recommends colorectal cancer screening for adults 45 to 75',
                category: 'reminder',
                sourceReferences: [guidelineSourceRef(guideline, 'screening for colorectal cancer')],
                safetyCritical: false,
            },
        ];
        const ledger: ClaimLedger = { claims };
        const draft: DraftBriefing = {
            segments: claims.map((c) => ({ text: c.text, claimIds: [c.id] })),
        };
        const { synth, mock: synthMock } = buildSynthesizer(ledger, draft);

        const documentEvidenceStore = {
            searchArtifacts: vi.fn(() => Promise.resolve([labArtifact()] as const)),
        };

        const supervisor: SupervisorDeps = {
            decide: scriptedSupervisor(scenario.sequence),
        };

        const graph = createBriefingGraph({
            retrieveChart: { client: snapshotClient, token: 'eval-token', siteId: 'default' },
            supervisor,
            documentEvidenceRetriever: { store: documentEvidenceStore },
            evidenceRetriever: { pineconeRetriever: pineconeRig.retriever, cohereRerank: cohere },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({
            envelope: baseEnvelope({ patient: { pid: PID, uuid: 'p-1' } }),
        });

        // Both retrievers were invoked — the supervisor walked the
        // scripted sequence without bypass.
        expect(documentEvidenceStore.searchArtifacts).toHaveBeenCalled();
        expect(pineconeRig.queryMock).toHaveBeenCalled();

        // Supervisor decision history contains both retriever handoffs +
        // a terminal synthesize. Every decision carries a non-empty
        // rationale per the architecture's plausibility rubric.
        const handoffs = out.supervisorDecisionHistory.map((d) => d.handoff);
        expect(handoffs).toContain('documentEvidenceRetriever');
        expect(handoffs).toContain('evidenceRetriever');
        expect(handoffs.at(-1)).toBe('synthesize');
        for (const decision of out.supervisorDecisionHistory) {
            expect(decision.reason.length).toBeGreaterThan(0);
        }

        // Cap was not the terminator — multi-retriever turns finish on
        // their own steam, not via the cap-hit forced-synthesize path.
        expect(out.capHit).toBe(false);

        // Synthesizer ran exactly once.
        expect(synthMock).toHaveBeenCalledTimes(1);

        // Final AssistantMessage cites both source types: the
        // extracted-document section AND the guideline section both
        // populate. The chart claim also surfaces, proving the
        // multi-source ledger feeds all three buckets without conflict.
        const formatted = out.formatted;
        expect(formatted).toBeDefined();
        if (formatted === null || formatted === undefined) return;
        expect(formatted.claimGroups.chart).toBeDefined();
        expect(formatted.claimGroups.extractedDocument).toBeDefined();
        expect(formatted.claimGroups.guideline).toBeDefined();
        expect(formatted.claimGroups.guideline?.claims.length).toBeGreaterThan(0);
        expect(formatted.claimGroups.extractedDocument?.cards.length).toBeGreaterThan(0);
    });
});
