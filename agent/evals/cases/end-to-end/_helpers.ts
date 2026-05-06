/**
 * End-to-end eval helpers for the Mrs. Patel scenario + refusal cases.
 *
 * The cases here are deterministic Vitest gates over the **whole** thin
 * slice — chart snapshot + extracted-document artifacts + guideline
 * snippets feed `verifyLedger`, then `format` produces the panel-shaped
 * `AssistantMessage`. Each case asserts one of the structural
 * invariants Phase D's MVP definition-of-done depends on:
 *
 *   - Three source-type sections render in the right order.
 *   - Every claim carries at least one `SourceReference`.
 *   - Cross-patient document leakage rejects in the verifier rather
 *     than landing in `claimGroups`.
 *   - Hidden, off-schema fields ("ssn") never surface in the output,
 *     because the schema's `.passthrough()` boundary drops them before
 *     the synthesizer ever sees them.
 *   - Off-scope questions produce a safe-refusal-shaped message.
 *
 * Real-vendor coverage of the same invariants lives in the nightly
 * LangSmith experiment (`endToEndSuite.ts`) — gated behind real-vendor
 * env vars, mirroring `conversationalGraphSuite`. The per-MR layer
 * uses the helpers below to feed the verifier + format directly,
 * which keeps the gate cheap and deterministic without running the
 * full LLM-driven graph.
 */

import { format } from '../../../src/graph/nodes/format.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type {
    AssistantMessage,
    BriefingSnapshot,
    Claim,
    DraftBriefing,
    DraftSegment,
    EvidenceRetrieverOutput,
    EvidenceSnippet,
    ExtractedFactSnippet,
    RequestEnvelope,
    VerifiedLedger,
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
import { verifyLedger } from '../../../src/verify/verifier.js';

/**
 * Mrs. Maya Patel — the scenario the demo & MVP definition-of-done
 * centers on. The chart shape is intentionally minimal — the case
 * wires extra rows in via overrides — but the demographics, encounter
 * history, and allergy/medication baseline match the seeded archetype
 * shape from `bin/seed/PatientArchetype.php` so the deterministic
 * gate stays aligned with what a real seeded chart looks like.
 */
export const PATEL_PID = 4201;
export const PATEL_UUID = 'p-patel-0001';
export const PATEL_OTHER_PID = 4299;

export const NOW = new Date('2026-05-06T00:00:00.000Z');

export const chartRef = (sourceId: string, field: string): SourceReference => ({
    source_type: 'chart',
    source_id: sourceId,
    locator: { field },
    quote: sourceId,
});

export const extractedDocRef = (snippet: ExtractedFactSnippet, quote: string): SourceReference => ({
    source_type: 'extracted_document',
    source_id: snippet.artifactId,
    locator: { field: snippet.fieldPath, page: snippet.page, bbox: snippet.bbox },
    quote,
    meta: { document_uuid: snippet.documentUuid },
});

export const guidelineRef = (snippet: EvidenceSnippet, quote: string): SourceReference => ({
    source_type: 'guideline',
    source_id: snippet.chunkId,
    locator: { section: snippet.section },
    quote,
});

interface PatelEnvelopeOverrides {
    readonly conversationId?: string;
    readonly requestId?: string;
    readonly task?: RequestEnvelope['task'];
    readonly question?: string;
    readonly patient?: RequestEnvelope['patient'];
}

export const patelEnvelope = (overrides: PatelEnvelopeOverrides = {}): RequestEnvelope => {
    const base: RequestEnvelope = {
        conversationId: overrides.conversationId ?? 'c-patel-1',
        requestId: overrides.requestId ?? 'r-patel-1',
        siteId: 'default',
        actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
        patient: overrides.patient ?? { pid: PATEL_PID, uuid: PATEL_UUID },
        task: overrides.task ?? 'follow_up',
    };
    return overrides.question === undefined ? base : { ...base, question: overrides.question };
};

interface PatelSnapshotOverrides {
    readonly diagnoses?: readonly Diagnosis[];
    readonly prescriptions?: readonly Prescription[];
    readonly allergies?: readonly Allergy[];
    readonly labs?: readonly LabObservation[];
    readonly encounters?: readonly Encounter[];
    readonly reminders?: readonly Reminder[];
    readonly medications?: readonly MedicationStatement[];
}

/**
 * Mrs. Patel's chart baseline — Type 2 diabetes diagnosis, metformin
 * prescription, sulfa allergy, A1c trending upward over three years.
 * The chart shape is the same one the seeded `patel_basecase`
 * archetype uses; tests override individual rows when a scenario
 * needs a richer or sparser chart.
 */
export const patelSnapshot = (overrides: PatelSnapshotOverrides = {}): BriefingSnapshot => ({
    patient: {
        pid: PATEL_PID,
        uuid: PATEL_UUID,
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: chartRef(String(PATEL_PID), 'patient.name'),
    },
    appointment: null,
    diagnoses:
        overrides.diagnoses ??
        ([
            {
                code: 'E11.9',
                codeSystem: 'ICD-10',
                label: 'Type 2 diabetes without complications',
                onsetDate: '2020-01-01',
                source: chartRef('dx-1', 'condition.code'),
            },
        ] as readonly Diagnosis[]),
    prescriptions:
        overrides.prescriptions ??
        ([
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
                source: chartRef('rx-met-1', 'medication.name'),
            },
        ] as readonly Prescription[]),
    allergies:
        overrides.allergies ??
        ([
            {
                substance: 'Sulfa drugs',
                reaction: 'rash',
                severity: 'moderate',
                source: chartRef('al-sulfa-1', 'allergy.substance'),
            },
        ] as readonly Allergy[]),
    labs: overrides.labs ?? [],
    encounters:
        overrides.encounters ??
        ([
            {
                encounterDate: '2026-04-01',
                type: 'office_visit',
                reason: 'Diabetes follow-up',
                source: chartRef('enc-1', 'encounter.reason'),
            },
        ] as readonly Encounter[]),
    reminders: overrides.reminders ?? [],
    medications: overrides.medications ?? [],
    labHistory: null,
});

/**
 * A lab-PDF artifact's extracted fact snippet — the shape the C.1
 * retriever projects each `ExtractionArtifact` into. The fixture
 * defaults match the seeded `patel_basecase` lab PDF (HbA1c 8.1%,
 * abnormal-high) so the verifier accepts a claim about it.
 */
export const labFactSnippet = (
    overrides: Partial<ExtractedFactSnippet> = {},
): ExtractedFactSnippet => ({
    artifactId: 'aaaa1111-bbbb-2222-cccc-3333dddddddd',
    documentUuid: 'doc-lab-patel-0001',
    docType: 'lab_pdf',
    fieldPath: 'results.0',
    value: 8.1,
    page: 1,
    bbox: [40, 200, 380, 220],
    quote: 'HbA1c 8.1 %',
    confidence: 0.94,
    extractorVersion: 'v1.0.0',
    createdAt: '2026-05-04T12:00:00.000Z',
    ...overrides,
});

/**
 * An intake-form artifact's extracted fact snippet. Defaults match
 * the seeded `patel_basecase` intake form: a self-reported new
 * symptom ("blurry vision in the morning") that the synthesizer can
 * cite without leaking off-schema fields.
 */
export const intakeFactSnippet = (
    overrides: Partial<ExtractedFactSnippet> = {},
): ExtractedFactSnippet => ({
    artifactId: 'eeee5555-ffff-6666-aaaa-7777bbbbbbbb',
    documentUuid: 'doc-intake-patel-0001',
    docType: 'intake_form',
    fieldPath: 'symptoms.0',
    value: 'blurry vision in the morning',
    page: 2,
    bbox: [50, 300, 360, 330],
    quote: 'Symptoms: blurry vision in the morning',
    confidence: 0.86,
    extractorVersion: 'v1.0.0',
    createdAt: '2026-05-04T12:30:00.000Z',
    ...overrides,
});

/** ADA glycemic-control snippet for the Patel scenario. */
export const DIABETES_GLYCEMIC_CHUNK = {
    chunkId: 'ada::glycemic-control--summary',
    publication: 'ADA',
    year: 2026,
    section: 'glycemic-targets',
    title: 'Glycemic Targets in Type 2 Diabetes',
    url: 'https://diabetesjournals.org/care/article/49/Supplement_1/S100/00000',
    licenseTier: 'public_domain',
    quote: 'For most non-pregnant adults with type 2 diabetes, an A1C target of <7% is reasonable; intensification of therapy should be considered when A1C exceeds the individualized goal.',
} as const;

export const guidelineSnippet = (overrides: Partial<EvidenceSnippet> = {}): EvidenceSnippet => ({
    chunkId: DIABETES_GLYCEMIC_CHUNK.chunkId,
    publication: DIABETES_GLYCEMIC_CHUNK.publication,
    year: DIABETES_GLYCEMIC_CHUNK.year,
    section: DIABETES_GLYCEMIC_CHUNK.section,
    title: DIABETES_GLYCEMIC_CHUNK.title,
    url: DIABETES_GLYCEMIC_CHUNK.url,
    licenseTier: DIABETES_GLYCEMIC_CHUNK.licenseTier,
    quote: DIABETES_GLYCEMIC_CHUNK.quote,
    rerankScore: 0.96,
    degradedRerank: false,
    ...overrides,
});

/**
 * Build a minimal `BriefingState` shaped fixture without running the
 * supervisor — what the per-MR end-to-end layer needs is verifier +
 * format coverage, not the full LangGraph cycle. The supervisor's
 * routing decisions are gated by `agent/tests/graph/nodes/supervisor.test.ts`;
 * the synthesizer's prompt by separate eval cases. This helper sits
 * **after** synthesizer output (a `DraftBriefing` pre-built by the
 * test) and feeds verify → format end to end.
 */
interface EndToEndArgs {
    readonly snapshot: BriefingSnapshot;
    readonly envelope: RequestEnvelope;
    readonly draft: DraftBriefing;
    readonly claims: readonly Claim[];
    readonly documentEvidenceSnippets?: readonly ExtractedFactSnippet[];
    readonly artifactConfidence?: ReadonlyMap<string, unknown>;
    readonly evidenceRetrieverOutput?: EvidenceRetrieverOutput;
}

export interface EndToEndOutcome {
    readonly verified: VerifiedLedger;
    readonly formatted: AssistantMessage;
}

export const runEndToEnd = async (args: EndToEndArgs): Promise<EndToEndOutcome> => {
    const verifyCtx: {
        documentEvidenceSnippets: readonly ExtractedFactSnippet[];
        artifactConfidence?: ReadonlyMap<string, unknown>;
        evidenceRetrieverOutput?: EvidenceRetrieverOutput;
    } = {
        documentEvidenceSnippets: args.documentEvidenceSnippets ?? [],
    };
    if (args.artifactConfidence !== undefined)
        verifyCtx.artifactConfidence = args.artifactConfidence;
    if (args.evidenceRetrieverOutput !== undefined)
        verifyCtx.evidenceRetrieverOutput = args.evidenceRetrieverOutput;

    const verified = verifyLedger(args.snapshot, { claims: args.claims }, verifyCtx);

    // Build the minimal BriefingState `format` reads. Slots `format`
    // doesn't touch are left at sensible defaults per `state.ts`.
    const state: BriefingState = {
        envelope: args.envelope,
        priorTurnContext: { turns: [] },
        snapshot: args.snapshot,
        draft: args.draft,
        claimLedger: { claims: args.claims },
        verified,
        formatted: null,
        persisted: null,
        retrieveChartCallCount: 1,
        retrieveChartArgs: null,
        documentEvidenceArgs: null,
        documentEvidenceSnippets: args.documentEvidenceSnippets ?? null,
        documentEvidenceArtifactConfidence: args.artifactConfidence ?? null,
        evidenceRetrieverArgs: null,
        evidenceRetrieverOutput: args.evidenceRetrieverOutput ?? null,
        supervisorIterations: 1,
        supervisorDecisionHistory: [],
        capHit: false,
        kickoffExtractionResults: [],
    };

    const update = await format(state);
    if (update.formatted === undefined || update.formatted === null) {
        throw new Error('format() did not produce an AssistantMessage');
    }
    return { verified, formatted: update.formatted };
};

/**
 * Compact draft-segment builder. The synthesizer's draft is a list
 * of prose segments; for end-to-end fixtures we hand-roll the
 * segments the synthesizer would have produced for a given
 * scenario.
 */
export const draftSegment = (text: string, claimIds: readonly string[]): DraftSegment => ({
    text,
    claimIds,
});
