/**
 * Conversational-graph eval helpers.
 *
 * The cases in this directory are deterministic Vitest gates over the
 * structural invariants the conversational graph must hold across a
 * turn: the document-evidence retriever, the guidelines retriever,
 * the verifier, the supervisor's multi-retriever sequencing, and the
 * iteration-cap backstop. Each case pins one invariant the per-MR
 * `test:agent` job must hold — patient-scope cannot widen, fabricated
 * bboxes reject, retriever gaps surface as unresolved citations,
 * low-confidence allergies fail the safety category closed, the
 * supervisor pulls both retrievers in a turn that needs both, and
 * the iteration cap binds when the supervisor would otherwise loop.
 *
 * The cases stub the retriever's external dependencies (Postgres for
 * extraction artifacts, Pinecone + Cohere for guidelines) and the
 * LLM seam (`SupervisorDecide`, `Synthesizer`) rather than standing
 * them up — this layer protects against structural regressions, not
 * model quality. Real-vendor coverage of the same invariants lives
 * in the nightly LangSmith experiment per `W2_ARCHITECTURE.md`
 * §"Eval Architecture".
 */

import type { BriefingState } from '../../../src/graph/state.js';
import type {
    BriefingSnapshot,
    EvidenceSnippet,
    ExtractedFactSnippet,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import type {
    Allergy,
    Diagnosis,
    Encounter,
    LabObservation,
    MedicationStatement,
    Prescription,
    Reminder,
    SourceReference,
} from '../../../src/snapshot/types.js';
import type {
    ExtractionArtifact,
    SearchArtifactsFilters,
} from '../../../src/state/extractionArtifacts.js';

export const PID = 42;
export const OTHER_PID = 99;

export const NOW = new Date('2026-05-05T00:00:00.000Z');

export const chartRef = (sourceId: string, field: string): SourceReference => ({
    source_type: 'chart',
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

export const baseEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'follow_up',
    question: 'recent A1c',
    ...overrides,
});

interface SnapshotOverrides {
    readonly diagnoses?: readonly Diagnosis[];
    readonly prescriptions?: readonly Prescription[];
    readonly allergies?: readonly Allergy[];
    readonly labs?: readonly LabObservation[];
    readonly encounters?: readonly Encounter[];
    readonly reminders?: readonly Reminder[];
    readonly medications?: readonly MedicationStatement[];
}

export const baseSnapshot = (overrides: SnapshotOverrides = {}): BriefingSnapshot => ({
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: chartRef(String(PID), 'patient.name'),
    },
    appointment: null,
    diagnoses: overrides.diagnoses ?? [],
    prescriptions: overrides.prescriptions ?? [],
    allergies: overrides.allergies ?? [],
    labs: overrides.labs ?? [],
    encounters: overrides.encounters ?? [],
    reminders: overrides.reminders ?? [],
    medications: overrides.medications ?? [],
    labHistory: null,
});

export const baseState = (overrides: Partial<BriefingState> = {}): BriefingState => ({
    envelope: baseEnvelope(),
    priorTurnContext: { turns: [] },
    snapshot: baseSnapshot(),
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 1,
    retrieveChartArgs: null,
    documentEvidenceArgs: null,
    documentEvidenceSnippets: null,
    documentEvidenceArtifactConfidence: null,
    evidenceRetrieverArgs: null,
    evidenceRetrieverOutput: null,
    supervisorIterations: 1,
    supervisorDecisionHistory: [],
    capHit: false, kickoffExtractionResults: [],
    ...overrides,
});

export const labArtifact = (overrides: Partial<ExtractionArtifact> = {}): ExtractionArtifact => ({
    artifactId: '11111111-1111-1111-1111-111111111111',
    documentUuid: '22222222-2222-2222-2222-222222222222',
    pid: PID,
    docType: 'lab_pdf',
    extractorVersion: 'v1.0.0',
    schemaJson: {
        results: [
            {
                analyte: 'HbA1c',
                value: 6.4,
                page: 1,
                bbox: [40, 200, 380, 220],
                quote: 'HbA1c 6.4 %',
                confidence: 0.93,
            },
        ],
    },
    deltasJson: null,
    confidenceSignal: { self_reported: 0.92, schema_warning_count: 0, patient_match: 'full' },
    status: 'pending_confirmation',
    documentHash: 'a'.repeat(64),
    createdAt: '2026-05-04T12:00:00.000Z',
    confirmedAt: null,
    confirmedByUser: null,
    ...overrides,
});

export const intakeArtifact = (overrides: Partial<ExtractionArtifact> = {}): ExtractionArtifact => ({
    artifactId: '33333333-3333-3333-3333-333333333333',
    documentUuid: '44444444-4444-4444-4444-444444444444',
    pid: PID,
    docType: 'intake_form',
    extractorVersion: 'v1.0.0',
    schemaJson: {
        allergies: [
            {
                substance: 'penicillin',
                page: 2,
                bbox: [50, 300, 250, 320],
                quote: 'Allergies: penicillin (rash)',
                confidence: 0.55,
            },
        ],
    },
    deltasJson: null,
    confidenceSignal: { self_reported: 0.55, schema_warning_count: 0, patient_match: 'full' },
    status: 'pending_confirmation',
    documentHash: 'b'.repeat(64),
    createdAt: '2026-05-04T12:00:00.000Z',
    confirmedAt: null,
    confirmedByUser: null,
    ...overrides,
});

/** Build a fake artifact store keyed by pid so cross-patient scope can be asserted. */
export const fakeArtifactStore = (
    artifactsByPid: ReadonlyMap<number, readonly ExtractionArtifact[]>,
): {
    readonly searchArtifacts: (filters: SearchArtifactsFilters) => Promise<readonly ExtractionArtifact[]>;
    readonly calls: SearchArtifactsFilters[];
} => {
    const calls: SearchArtifactsFilters[] = [];
    return {
        calls,
        searchArtifacts: (filters) => {
            calls.push(filters);
            const rows = artifactsByPid.get(filters.pid) ?? [];
            const matched = rows.filter((row) => {
                if (filters.docTypes !== undefined && !filters.docTypes.includes(row.docType)) {
                    return false;
                }
                return Date.parse(row.createdAt) >= filters.since.getTime();
            });
            return Promise.resolve(matched);
        },
    };
};

export const COLORECTAL_CHUNK = {
    chunkId: 'uspstf::colorectal-cancer-screening--recommendation-summary',
    publication: 'USPSTF',
    year: 2021,
    section: 'recommendation-summary',
    title: 'Colorectal Cancer: Screening',
    url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening',
    licenseTier: 'public_domain',
    quote:
        'The USPSTF recommends screening for colorectal cancer in all adults aged 45 to 75 years. (B recommendation)',
} as const;

export const guidelineSnippet = (overrides: Partial<EvidenceSnippet> = {}): EvidenceSnippet => ({
    chunkId: COLORECTAL_CHUNK.chunkId,
    publication: COLORECTAL_CHUNK.publication,
    year: COLORECTAL_CHUNK.year,
    section: COLORECTAL_CHUNK.section,
    title: COLORECTAL_CHUNK.title,
    url: COLORECTAL_CHUNK.url,
    licenseTier: COLORECTAL_CHUNK.licenseTier,
    quote: COLORECTAL_CHUNK.quote,
    rerankScore: 0.97,
    degradedRerank: false,
    ...overrides,
});

export const extractedDocRef = (
    snippet: ExtractedFactSnippet,
    quote: string,
): SourceReference => ({
    source_type: 'extracted_document',
    source_id: snippet.artifactId,
    locator: {
        field: snippet.fieldPath,
        page: snippet.page,
        bbox: snippet.bbox,
    },
    quote,
});

/**
 * Build an `ExtractedFactSnippet` directly without round-tripping
 * through the retriever's projection. Cases that exercise the
 * verifier's `extracted_document` resolution don't need the
 * projection — they just need a snippet shape that mirrors what the
 * retriever would have produced.
 */
export const factSnippet = (
    overrides: Partial<ExtractedFactSnippet> = {},
): ExtractedFactSnippet => ({
    artifactId: '11111111-1111-1111-1111-111111111111',
    documentUuid: '22222222-2222-2222-2222-222222222222',
    docType: 'lab_pdf',
    fieldPath: 'results.0',
    value: 6.4,
    page: 1,
    bbox: [40, 200, 380, 220],
    quote: 'HbA1c 6.4 %',
    confidence: 0.93,
    extractorVersion: 'v1.0.0',
    createdAt: '2026-05-04T12:00:00.000Z',
    ...overrides,
});

export const guidelineSourceRef = (
    snippet: EvidenceSnippet,
    quote: string,
): SourceReference => ({
    source_type: 'guideline',
    source_id: snippet.chunkId,
    locator: { section: snippet.section },
    quote,
});
