/**
 * Conversational-graph experiment target.
 *
 * Each of the three case groups exercises a specific structural
 * invariant the conversational graph must hold; the per-MR Vitest
 * cases at `agent/evals/cases/conversational-graph/` pin those
 * invariants over stubbed vendors. This target re-runs the same
 * scenarios through the **real** `briefingGraph` against real
 * Anthropic, and (for the `guidelines` case) real Pinecone+Cohere.
 *
 * The verdict reducer keys off whichever surface is load-bearing for
 * the case:
 *   - `document-evidence`: did the verifier accept ≥1
 *     `extracted_document` claim? (verifier-accepted)
 *   - `guidelines`: did the verifier accept ≥1 `guideline` claim?
 *     (verifier-accepted)
 *   - `verification`: did the verifier fire
 *     `HARD_STOP_ALLERGIES_UNAVAILABLE`? (hard-stop)
 *
 * The target keeps the deterministic per-MR layer's framing intact:
 * each verdict maps 1:1 to one of the dataset's `expectedGate`
 * values, so an experiment row that drifts surfaces in the same diff
 * as a Vitest regression.
 */

import { createBriefingGraph } from '../../src/graph/index.js';
import type { DocumentEvidenceRetrieverDeps } from '../../src/graph/nodes/documentEvidenceRetriever.js';
import type { EvidenceRetrieverDeps } from '../../src/graph/nodes/evidenceRetriever.js';
import {
    createAnthropicSupervisorDecide,
    type SupervisorDecide,
} from '../../src/graph/nodes/supervisor.js';
import { createAnthropicSynthesizer } from '../../src/graph/nodes/synthesize.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { BriefingSnapshot, RequestEnvelope } from '../../src/graph/types.js';
import { HARD_STOP_ALLERGIES_UNAVAILABLE } from '../../src/verify/verifier.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';
import type {
    ExtractionArtifact,
    ExtractionArtifactStore,
    SearchArtifactsFilters,
} from '../../src/state/extractionArtifacts.js';

import { buildDatasetSnapshotClient } from './shared.js';

export type ConversationalGraphCaseId = 'document-evidence' | 'guidelines' | 'verification';

export type ConversationalGraphVerdict =
    | 'verifier-accepted'
    | 'verifier-rejected'
    | 'gap-emitted'
    | 'hard-stop';

export interface ConversationalGraphCaseRunResult {
    readonly group: ConversationalGraphCaseId;
    readonly verdict: ConversationalGraphVerdict;
    readonly verifierPassed: boolean;
    readonly acceptedClaimCount: number;
    readonly rejectedClaimCount: number;
    readonly hardStops: readonly string[];
    readonly supervisorIterations: number;
}

const PID = 4201;
const UUID = 'p-cg-0001';

const chartSrc = (sourceId: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

const baseSnapshot = (): BriefingSnapshot => ({
    patient: {
        pid: PID,
        uuid: UUID,
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: chartSrc(String(PID), 'patient.name'),
    },
    appointment: null,
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes without complications',
            onsetDate: '2020-01-01',
            source: chartSrc('dx-1', 'condition.code'),
        },
    ],
    prescriptions: [
        {
            name: 'Metformin 500 mg',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-15',
            stopDate: null,
            prescriber: 'Dr. Patel',
            indication: 'Type 2 diabetes',
            prescriptionId: 'rx-met-1',
            source: chartSrc('rx-met-1', 'medication.name'),
        },
    ],
    allergies: [],
    labs: [],
    encounters: [
        {
            encounterDate: '2026-04-01',
            type: 'office_visit',
            reason: 'Diabetes follow-up',
            source: chartSrc('enc-1', 'encounter.reason'),
        },
    ],
    reminders: [],
    medications: [],
    labHistory: null,
});

const labArtifact: ExtractionArtifact = {
    artifactId: 'aaaa1111-bbbb-2222-cccc-3333dddddddd',
    documentUuid: 'doc-cg-lab-0001',
    pid: PID,
    docType: 'lab_pdf',
    extractorVersion: 'v1.0.0',
    schemaJson: {
        results: [
            {
                analyte: 'HbA1c',
                value: 7.6,
                unit: '%',
                page: 1,
                bbox: [40, 200, 380, 220],
                quote: 'HbA1c 7.6 %',
                confidence: 0.94,
            },
        ],
    },
    deltasJson: null,
    confidenceSignal: { self_reported: 0.94, schema_warning_count: 0, patient_match: 'full' },
    status: 'pending_confirmation',
    documentHash: 'a'.repeat(64),
    createdAt: '2026-05-04T12:00:00.000Z',
    confirmedAt: null,
    confirmedByUser: null,
};

const lowConfidenceAllergyArtifact: ExtractionArtifact = {
    artifactId: 'bbbb2222-cccc-3333-dddd-4444eeeeeeee',
    documentUuid: 'doc-cg-intake-0001',
    pid: PID,
    docType: 'intake_form',
    extractorVersion: 'v1.0.0',
    schemaJson: {
        allergies: [
            {
                substance: 'penicillin',
                reaction: 'rash',
                page: 2,
                bbox: [50, 300, 250, 320],
                quote: 'Allergies: penicillin (rash)',
                confidence: 0.55,
            },
        ],
    },
    deltasJson: null,
    // Low self_reported confidence drives
    // HARD_STOP_ALLERGIES_UNAVAILABLE per the verifier's combined-
    // signal rule.
    confidenceSignal: { self_reported: 0.55, schema_warning_count: 0, patient_match: 'full' },
    status: 'pending_confirmation',
    documentHash: 'b'.repeat(64),
    createdAt: '2026-05-04T12:30:00.000Z',
    confirmedAt: null,
    confirmedByUser: null,
};

const buildArtifactStore = (
    artifacts: readonly ExtractionArtifact[],
): Pick<ExtractionArtifactStore, 'searchArtifacts'> => ({
    searchArtifacts: (filters: SearchArtifactsFilters) =>
        Promise.resolve(
            artifacts.filter((a) => {
                if (a.pid !== filters.pid) return false;
                if (filters.docTypes !== undefined && !filters.docTypes.includes(a.docType)) {
                    return false;
                }
                return Date.parse(a.createdAt) >= filters.since.getTime();
            }),
        ),
});

interface CaseFixture {
    readonly snapshot: BriefingSnapshot;
    readonly envelope: RequestEnvelope;
    readonly artifacts: readonly ExtractionArtifact[];
}

const fixtureFor = (group: ConversationalGraphCaseId): CaseFixture => {
    switch (group) {
        case 'document-evidence':
            return {
                snapshot: baseSnapshot(),
                envelope: {
                    conversationId: `cg-${group}`,
                    requestId: `cg-${group}-req-1`,
                    siteId: 'default',
                    actor: {
                        userId: 'experiment',
                        fhirUser: 'https://emr/Practitioner/experiment',
                    },
                    patient: { pid: PID, uuid: UUID },
                    task: 'follow_up',
                    question: 'What does her recent HbA1c lab show?',
                },
                artifacts: [labArtifact],
            };
        case 'guidelines':
            return {
                snapshot: baseSnapshot(),
                envelope: {
                    conversationId: `cg-${group}`,
                    requestId: `cg-${group}-req-1`,
                    siteId: 'default',
                    actor: {
                        userId: 'experiment',
                        fhirUser: 'https://emr/Practitioner/experiment',
                    },
                    patient: { pid: PID, uuid: UUID },
                    task: 'follow_up',
                    question:
                        'When is colorectal cancer screening recommended for adults — what does USPSTF say?',
                },
                artifacts: [],
            };
        case 'verification':
            return {
                snapshot: baseSnapshot(),
                envelope: {
                    conversationId: `cg-${group}`,
                    requestId: `cg-${group}-req-1`,
                    siteId: 'default',
                    actor: {
                        userId: 'experiment',
                        fhirUser: 'https://emr/Practitioner/experiment',
                    },
                    patient: { pid: PID, uuid: UUID },
                    task: 'follow_up',
                    question:
                        'Does the new intake form list any allergies, and is the metformin still appropriate?',
                },
                artifacts: [lowConfidenceAllergyArtifact],
            };
    }
};

const reduceVerdict = (
    group: ConversationalGraphCaseId,
    args: {
        readonly verifierPassed: boolean;
        readonly acceptedCount: number;
        readonly rejectedCount: number;
        readonly hardStops: readonly string[];
        readonly iterations: number;
        readonly accepted: readonly { source_type: string }[];
    },
): ConversationalGraphCaseRunResult => {
    let verdict: ConversationalGraphVerdict;
    if (args.hardStops.includes(HARD_STOP_ALLERGIES_UNAVAILABLE)) {
        verdict = 'hard-stop';
    } else if (group === 'document-evidence') {
        verdict = args.accepted.some((c) => c.source_type === 'extracted_document')
            ? 'verifier-accepted'
            : 'verifier-rejected';
    } else if (group === 'guidelines') {
        verdict = args.accepted.some((c) => c.source_type === 'guideline')
            ? 'verifier-accepted'
            : args.rejectedCount > 0
              ? 'verifier-rejected'
              : 'gap-emitted';
    } else {
        // verification group; if no hard-stop fired and the case
        // expected one, surface as verifier-accepted (the gate
        // didn't activate even though it should have). The dataset
        // row's expectedGate of 'hard-stop' will then mismatch and
        // the LangSmith UI flags the regression.
        verdict = args.verifierPassed ? 'verifier-accepted' : 'verifier-rejected';
    }
    return {
        group,
        verdict,
        verifierPassed: args.verifierPassed,
        acceptedClaimCount: args.acceptedCount,
        rejectedClaimCount: args.rejectedCount,
        hardStops: args.hardStops,
        supervisorIterations: args.iterations,
    };
};

export interface ConversationalGraphTargetDeps {
    readonly anthropicApiKey: string;
    readonly evidenceRetriever?: EvidenceRetrieverDeps;
    readonly supervisorDecide?: SupervisorDecide;
    readonly synthesizer?: Synthesizer;
}

export const runConversationalGraphCase = async (
    group: ConversationalGraphCaseId,
    deps: ConversationalGraphTargetDeps,
): Promise<ConversationalGraphCaseRunResult> => {
    const fixture = fixtureFor(group);

    const synthesizer =
        deps.synthesizer ?? createAnthropicSynthesizer({ apiKey: deps.anthropicApiKey });

    const supervisorDecide =
        deps.supervisorDecide ?? createAnthropicSupervisorDecide({ apiKey: deps.anthropicApiKey });

    const documentEvidenceDeps: DocumentEvidenceRetrieverDeps = {
        store: buildArtifactStore(fixture.artifacts),
    };

    // Wire evidenceRetriever whenever Pinecone+Cohere deps are
    // available — the supervisor decides whether to call it. The
    // per-fixture flag was a premature optimization that left the
    // graph with the §A.7 stub on rows where the model legitimately
    // routed to evidenceRetriever, surfacing as `phase-A stub
    // invoked` warnings in the experiment logs.
    const evidenceRetrieverDeps =
        deps.evidenceRetriever !== undefined ? { evidenceRetriever: deps.evidenceRetriever } : {};

    const graphDeps = {
        retrieveChart: {
            client: buildDatasetSnapshotClient(fixture.snapshot),
            token: 'experiment',
            siteId: 'default',
        },
        supervisor: { decide: supervisorDecide },
        synthesize: { synthesizer },
        verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        documentEvidenceRetriever: documentEvidenceDeps,
        ...evidenceRetrieverDeps,
    };

    const graph = createBriefingGraph(graphDeps);
    const out = await graph.invoke({ envelope: fixture.envelope });
    const verified = out.verified;

    return reduceVerdict(group, {
        verifierPassed: verified?.passed === true,
        acceptedCount: verified?.accepted.length ?? 0,
        rejectedCount: verified?.rejected.length ?? 0,
        hardStops: verified?.safetyHardStops ?? [],
        iterations: out.supervisorIterations ?? 0,
        accepted: (verified?.accepted ?? []).map((c) => ({
            source_type: c.sourceReferences[0]?.source_type ?? '',
        })),
    });
};
