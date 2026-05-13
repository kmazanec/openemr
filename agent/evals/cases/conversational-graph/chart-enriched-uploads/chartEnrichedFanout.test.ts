/**
 * Regression: a default_briefing turn with many un-extracted
 * chart-side documents (the `enrichPendingUploads` path) must not
 * loop the supervisor through `kickoffExtraction` on every entry
 * until the iteration cap binds.
 *
 * Repro from the prod trace: a fresh briefing with 10 chart-enriched
 * pendingUploads — none of them attached by the clinician this turn,
 * just sitting on the chart from prior legacy-Documents-UI uploads —
 * fanned the supervisor out to kickoffExtraction 10 times in a row,
 * exhausted LangGraph's recursionLimit, and never reached
 * synthesize. With the fix:
 *
 *   - The supervisor's observation hides all but the most recent N
 *     chart-enriched entries (visibility cap).
 *   - The prompt instructs the supervisor not to auto-extract
 *     chart-enriched entries; only chat-upload entries are
 *     auto-extracted, and chart-enriched entries are extracted only
 *     when the clinician's question this turn references them.
 *   - Chart-enriched entries do NOT block synthesize.
 *
 * The case asserts the structural gate: even with a "naive"
 * supervisor stub that mimics the real-LLM bug (always extract any
 * unprocessed pendingUpload it sees), the visibility cap keeps the
 * fanout bounded.
 */

import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../../src/graph/index.js';
import type {
    SupervisorDecide,
    SupervisorDeps,
} from '../../../../src/graph/nodes/supervisor.js';
import type { Synthesizer } from '../../../../src/graph/nodes/synthesize.js';
import type { BriefingState, BriefingStateUpdate } from '../../../../src/graph/state.js';
import type {
    Claim,
    ClaimLedger,
    DraftBriefing,
    KickoffExtractionResult,
    PendingUpload,
    SupervisorDecision,
} from '../../../../src/graph/types.js';
import type { PineconeRetriever } from '../../../../src/retrievers/pinecone.js';
import type { CohereRerankClient } from '../../../../src/retrievers/cohere.js';
import type { ChartSnapshot } from '../../../../src/snapshot/types.js';
import type { SnapshotClient } from '../../../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../../../src/verify/unverifiedClaimsLog.js';

import { PID, baseEnvelope, baseSnapshot, chartRef } from '../_helpers.js';

const buildSnapshotClient = (): SnapshotClient => {
    const snap = baseSnapshot();
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

const buildSynthesizer = (
    ledger: ClaimLedger,
    draft: DraftBriefing,
): { readonly synth: Synthesizer; readonly mock: ReturnType<typeof vi.fn> } => {
    const mock = vi.fn(() => Promise.resolve({ draft, ledger }));
    return { synth: mock, mock };
};

/**
 * Naive supervisor stub that mirrors the real-LLM bug from the prod
 * trace: for every iteration, if observation.pendingUploads has an
 * entry whose documentUuid isn't yet in
 * kickoffExtractionResultsThisTurn, pick kickoffExtraction on it.
 * Otherwise synthesize.
 *
 * Without the visibility cap, this stub fans out to N
 * kickoffExtraction calls (one per chart-enriched entry) before
 * picking synthesize — N=10 hits the LangGraph recursion limit.
 * With the cap, the supervisor only ever sees up to
 * CHART_ENRICHED_VISIBILITY_CAP chart-enriched entries, so the loop
 * terminates in bounded steps.
 */
const naiveExtractAllSupervisor = (): SupervisorDecide => {
    return vi.fn<SupervisorDecide>(({ observation }) => {
        const processed = new Set(
            observation.kickoffExtractionResultsThisTurn.map((r) => r.documentUuid),
        );
        const next = observation.pendingUploads.find(
            (p) => !processed.has(p.documentUuid),
        );
        const decision: SupervisorDecision = next !== undefined
            ? {
                  handoff: 'kickoffExtraction',
                  reason: 'naive stub: extract next pending upload',
                  narration: 'Extracting an attached document.',
                  args: {
                      document_uuid: next.documentUuid,
                      doc_type: next.docType,
                  },
              }
            : {
                  handoff: 'synthesize',
                  reason: 'naive stub: no unprocessed pendingUploads remain',
                  narration: 'Drafting the briefing.',
              };
        return Promise.resolve(decision);
    });
};

/**
 * Stub `kickoffExtraction` node override that pretends every kickoff
 * succeeded — we don't care about pipeline behavior here, only about
 * how many times the supervisor picks the handoff.
 */
const fakeKickoffNode = vi.fn(
    (state: BriefingState): Promise<BriefingStateUpdate> => {
        const last = state.supervisorDecisionHistory.at(-1);
        const args = last?.args as { document_uuid?: string; doc_type?: string } | undefined;
        const docType: KickoffExtractionResult['docType'] =
            args?.doc_type === 'intake_form'
                ? 'intake_form'
                : args?.doc_type === 'referral_letter'
                  ? 'referral_letter'
                  : 'lab_pdf';
        const documentUuid =
            typeof args?.document_uuid === 'string' ? args.document_uuid : '';
        const result: KickoffExtractionResult = {
            documentUuid,
            docType,
            status: 'persisted',
            artifactId: 'artifact-' + (documentUuid !== '' ? documentUuid : 'x'),
            errorCode: null,
            idempotencyHit: false,
        };
        return Promise.resolve({
            kickoffExtractionResults: [...state.kickoffExtractionResults, result],
        });
    },
);

const buildChartEnrichedUploads = (count: number): readonly PendingUpload[] =>
    Array.from({ length: count }, (_, i) => ({
        documentUuid: `chart-doc-${String(i + 1).padStart(2, '0')}`,
        docType: 'lab_pdf' as const,
        canonicalExt: 'pdf',
        source: 'chart-enriched' as const,
        filename: `lab-report-${String(i + 1)}.pdf`,
    }));

describe('chart-enriched pendingUploads — supervisor fanout cap', () => {
    it('bounds kickoffExtraction picks even with 10 chart-enriched entries and a naive supervisor', async () => {
        const snapshotClient = buildSnapshotClient();
        const documentStore = buildEmptyDocumentStore();
        const pinecone = buildEmptyPinecone();
        const cohere = buildEmptyCohere();

        const claims: readonly Claim[] = [
            {
                id: 'cl-1',
                text: 'Patient: Patel, Maya, 58 F',
                category: 'identity',
                sourceReferences: [chartRef(String(PID), 'patient.name')],
                safetyCritical: false,
            },
        ];
        const ledger: ClaimLedger = { claims };
        const draft: DraftBriefing = {
            segments: claims.map((c) => ({ text: c.text, claimIds: [c.id] })),
        };
        const { synth, mock: synthMock } = buildSynthesizer(ledger, draft);

        const supervisor: SupervisorDeps = {
            decide: naiveExtractAllSupervisor(),
            iterationCap: 10,
        };

        fakeKickoffNode.mockClear();

        const graph = createBriefingGraph({
            retrieveChart: { client: snapshotClient, token: 'eval-token', siteId: 'default' },
            supervisor,
            documentEvidenceRetriever: { store: documentStore },
            evidenceRetriever: { pineconeRetriever: pinecone, cohereRerank: cohere },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            kickoffExtractionNodeOverride: fakeKickoffNode,
        });

        // Hand-build the envelope rather than going through
        // baseEnvelope({ question: undefined }) — the helper's default
        // sets `question` to a string and `exactOptionalPropertyTypes`
        // rejects `undefined` overrides for required-when-present
        // fields.
        const envelopeWithoutQuestion = {
            ...baseEnvelope(),
            task: 'default_briefing' as const,
            pendingUploads: buildChartEnrichedUploads(10),
        };
        delete (envelopeWithoutQuestion as { question?: string }).question;

        const out = await graph.invoke({
            envelope: envelopeWithoutQuestion,
        });

        // The visibility cap is 3 — even with 10 unprocessed
        // chart-enriched entries, the supervisor only ever sees the
        // top 3 in its observation, so it picks kickoffExtraction at
        // most 3 times before exhausting visible candidates and
        // picking synthesize.
        expect(fakeKickoffNode).toHaveBeenCalledTimes(3);

        // The graph reached synthesize without tripping the
        // iteration cap. capHit=true would mean we burned all 10
        // iterations on extractions instead of producing a briefing.
        expect(out.capHit).toBe(false);
        expect(synthMock).toHaveBeenCalledTimes(1);

        // Briefing rendered end-to-end.
        const formatted = out.formatted;
        expect(formatted).toBeDefined();
        if (formatted === null || formatted === undefined) return;
        expect(formatted.segments.length).toBeGreaterThan(0);
    });

    it('still auto-extracts chat-upload entries (regression guard for the other direction)', async () => {
        const snapshotClient = buildSnapshotClient();
        const documentStore = buildEmptyDocumentStore();
        const pinecone = buildEmptyPinecone();
        const cohere = buildEmptyCohere();

        const claims: readonly Claim[] = [
            {
                id: 'cl-1',
                text: 'Patient: Patel, Maya, 58 F',
                category: 'identity',
                sourceReferences: [chartRef(String(PID), 'patient.name')],
                safetyCritical: false,
            },
        ];
        const ledger: ClaimLedger = { claims };
        const draft: DraftBriefing = {
            segments: claims.map((c) => ({ text: c.text, claimIds: [c.id] })),
        };
        const { synth } = buildSynthesizer(ledger, draft);

        const supervisor: SupervisorDeps = {
            decide: naiveExtractAllSupervisor(),
            iterationCap: 10,
        };

        fakeKickoffNode.mockClear();

        const graph = createBriefingGraph({
            retrieveChart: { client: snapshotClient, token: 'eval-token', siteId: 'default' },
            supervisor,
            documentEvidenceRetriever: { store: documentStore },
            evidenceRetriever: { pineconeRetriever: pinecone, cohereRerank: cohere },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            kickoffExtractionNodeOverride: fakeKickoffNode,
        });

        // One chat-upload (load-bearing) + two chart-enriched (would
        // be filtered to two anyway, under the cap of 3). The
        // chat-upload must still be extracted.
        const uploads: readonly PendingUpload[] = [
            {
                documentUuid: 'chat-doc-1',
                docType: 'lab_pdf',
                canonicalExt: 'pdf',
                source: 'chat-upload',
                filename: null,
            },
            {
                documentUuid: 'chart-doc-A',
                docType: 'lab_pdf',
                canonicalExt: 'pdf',
                source: 'chart-enriched',
                filename: 'old-lab.pdf',
            },
        ];

        const out = await graph.invoke({
            envelope: baseEnvelope({
                task: 'follow_up',
                question: 'what does this lab say?',
                pendingUploads: uploads,
            }),
        });

        // The chat-upload was extracted; the chart-enriched was also
        // extracted by the naive stub (the LLM-in-prod is what reads
        // the prompt and decides). The key invariant is that both
        // are present (cap doesn't drop chat-upload) and the run
        // terminates without cap-hit.
        const extracted = fakeKickoffNode.mock.calls.length;
        expect(extracted).toBeGreaterThanOrEqual(1);
        expect(extracted).toBeLessThanOrEqual(uploads.length);
        const extractedUuids = out.kickoffExtractionResults.map((r) => r.documentUuid);
        expect(extractedUuids).toContain('chat-doc-1');
        expect(out.capHit).toBe(false);
    });
});
