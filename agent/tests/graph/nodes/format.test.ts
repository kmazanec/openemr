import { describe, expect, it } from 'vitest';

import { format } from '../../../src/graph/nodes/format.js';
import type {
    BriefingSnapshot,
    Claim,
    DraftBriefing,
    RequestEnvelope,
    VerifiedLedger,
} from '../../../src/graph/types.js';

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const FIELD_FOR_RECORD_TYPE: Record<string, string> = {
    Patient: 'patient.name',
    Appointment: 'appointment.start',
    Condition: 'condition.code',
    MedicationRequest: 'medication.name',
    AllergyIntolerance: 'allergy.substance',
    Observation: 'observation.value',
    Encounter: 'encounter.date',
    Task: 'task.description',
    MedicationStatement: 'medicationStatement.medication',
    DocumentReference: 'documentReference.text',
};

const sourceRef = (recordType: string, recordId: string) => ({
    source_type: 'chart' as const,
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        ageYears: 58,
        source: sourceRef('Patient', '42'),
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

const snapshotWithA1cLab: BriefingSnapshot = {
    ...snapshot,
    labs: [
        {
            analyte: 'A1c',
            value: '8.4',
            unit: '%',
            referenceRange: null,
            abnormalFlag: 'H',
            observedAt: null,
            source: sourceRef('Observation', 'lab-1'),
        },
    ],
};

const dxClaim: Claim = {
    id: 'dx-1',
    text: 'Type 2 diabetes (E11.9)',
    category: 'diagnosis',
    sourceReferences: [sourceRef('Condition', 'c-1')],
    safetyCritical: false,
};

const medClaim: Claim = {
    id: 'med-1',
    text: 'Metformin 500 mg PO BID',
    category: 'prescription',
    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
    safetyCritical: true,
};

const allergyClaim: Claim = {
    id: 'alg-1',
    text: 'Penicillin allergy',
    category: 'allergy',
    sourceReferences: [sourceRef('AllergyIntolerance', 'a-1')],
    safetyCritical: true,
};

const labClaim: Claim = {
    id: 'lab-1',
    text: 'A1c 8.4%',
    category: 'lab',
    sourceReferences: [sourceRef('Observation', 'lab-1')],
    safetyCritical: false,
};

const cleanVerified: VerifiedLedger = {
    passed: true,
    accepted: [dxClaim, medClaim, allergyClaim, labClaim],
    rejected: [],
    safetyHardStops: [],
};

const draftSegments = (
    ...segments: { text: string; claimIds: string[] }[]
): DraftBriefing => ({ segments });

const baseState = (
    overrides: {
        draft?: DraftBriefing;
        verified?: VerifiedLedger;
        snapshot?: BriefingSnapshot;
        envelope?: RequestEnvelope;
    } = {},
) => ({
    envelope: overrides.envelope ?? envelope,
    snapshot: overrides.snapshot ?? snapshot,
    priorTurnContext: { turns: [] },
    draft: overrides.draft ?? draftSegments(),
    claimLedger: { claims: [dxClaim, medClaim, allergyClaim, labClaim] },
    verified: overrides.verified ?? cleanVerified,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 0,
    retrieveChartArgs: null,    documentEvidenceArgs: null,    documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,    evidenceRetrieverArgs: null,    evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false,
});

describe('format', () => {
    it('passes accepted segments through with their resolved claims attached', async () => {
        const draft = draftSegments(
            { text: 'Mrs. Patel has type 2 diabetes (E11.9).', claimIds: ['dx-1'] },
            { text: 'She takes metformin 500 mg BID.', claimIds: ['med-1'] },
        );
        const out = await format(baseState({ draft }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments).toHaveLength(2);
        expect(f.segments[0]?.text).toContain('type 2 diabetes');
        expect(f.segments[0]?.redacted).toBe(false);
        expect(f.segments[0]?.claims.map((c) => c.id)).toEqual(['dx-1']);
        expect(f.segments[1]?.claims.map((c) => c.id)).toEqual(['med-1']);
        expect(f.gaps).toEqual([]);
    });

    it('passes connector segments through with empty claims and not redacted', async () => {
        const draft = draftSegments(
            { text: 'Active diagnoses include:', claimIds: [] },
            { text: 'Type 2 diabetes (E11.9).', claimIds: ['dx-1'] },
        );
        const out = await format(baseState({ draft }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments[0]?.text).toBe('Active diagnoses include:');
        expect(f.segments[0]?.claims).toEqual([]);
        expect(f.segments[0]?.redacted).toBe(false);
    });

    it('redacts a segment whose claim id was rejected by the verifier', async () => {
        // Verifier accepted dx-1 but rejected med-1. The original prose
        // ("She takes metformin 500 mg BID") asserts an unverified fact;
        // coherent fail-closed means the renderer must NEVER see that
        // text.
        const verified: VerifiedLedger = {
            passed: false,
            accepted: [dxClaim],
            rejected: [{ claim: medClaim, reason: 'source-record-not-in-snapshot' }],
            safetyHardStops: [],
        };
        const draft = draftSegments(
            { text: 'She has type 2 diabetes.', claimIds: ['dx-1'] },
            { text: 'She takes metformin 500 mg BID.', claimIds: ['med-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments).toHaveLength(2);
        expect(f.segments[0]?.redacted).toBe(false);
        expect(f.segments[1]?.redacted).toBe(true);
        expect(f.segments[1]?.text).not.toContain('metformin');
        expect(f.segments[1]?.claims).toEqual([]);
    });

    it('redacts a segment whose claim id is missing from the verifier-accepted set entirely (marker-miss recovery)', async () => {
        // Marker-miss recovery: the model emitted a segment citing a
        // claimId that does not appear in the ledger at all (or in
        // accepted). Treat exactly like a rejection — redact, do not
        // pass the original text through, do not throw.
        const draft = draftSegments(
            { text: 'She has type 2 diabetes.', claimIds: ['dx-1'] },
            { text: 'She is allergic to bees.', claimIds: ['phantom-id'] },
        );
        const out = await format(baseState({ draft }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments[1]?.redacted).toBe(true);
        expect(f.segments[1]?.text).not.toContain('bees');
    });

    it('redacts every segment whose claim category is suppressed by an allergies-unavailable hard stop', async () => {
        // Mirrors §3.3 hard rule: "missing allergies → no medication
        // summary shown". The medication segment must not pass through,
        // even though the claim itself is technically in `accepted`.
        const verified: VerifiedLedger = {
            passed: false,
            accepted: [dxClaim, medClaim],
            rejected: [],
            safetyHardStops: ['allergies-unavailable'],
        };
        const draft = draftSegments(
            { text: 'Type 2 diabetes (E11.9).', claimIds: ['dx-1'] },
            { text: 'Metformin 500 mg BID.', claimIds: ['med-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments[0]?.redacted).toBe(false);
        expect(f.segments[1]?.redacted).toBe(true);
        expect(f.segments[1]?.text).not.toContain('Metformin');
        // The hard stop also surfaces as a message-level gap.
        expect(f.gaps).toEqual([
            {
                kind: 'gap',
                reason: 'allergies-unavailable',
                message: 'Allergy data is unavailable; prescription summary withheld.',
            },
        ]);
    });

    it('surfaces a prescriptions-unavailable hard stop as a message-level gap and redacts medication segments', async () => {
        const verified: VerifiedLedger = {
            passed: false,
            accepted: [dxClaim, medClaim],
            rejected: [],
            safetyHardStops: ['prescriptions-unavailable'],
        };
        const draft = draftSegments(
            { text: 'Diabetes (E11.9).', claimIds: ['dx-1'] },
            { text: 'On metformin BID.', claimIds: ['med-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments[1]?.redacted).toBe(true);
        expect(f.gaps).toEqual([
            {
                kind: 'gap',
                reason: 'prescriptions-unavailable',
                message: 'Prescription data is unavailable.',
            },
        ]);
    });

    it('throws when called without verified state (verifier must run first)', async () => {
        await expect(
            format({
                envelope,
                snapshot,
                priorTurnContext: { turns: [] },
                draft: draftSegments({ text: 'x', claimIds: [] }),
                claimLedger: { claims: [] },
                verified: null,
                formatted: null,
                persisted: null,
                retrieveChartCallCount: 0,
                retrieveChartArgs: null,                documentEvidenceArgs: null,                documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,                evidenceRetrieverArgs: null,                evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false,
            }),
        ).rejects.toThrow(/verify/i);
    });

    it('throws when called without a draft (synthesizer must run first)', async () => {
        await expect(
            format({
                envelope,
                snapshot,
                priorTurnContext: { turns: [] },
                draft: null,
                claimLedger: { claims: [] },
                verified: cleanVerified,
                formatted: null,
                persisted: null,
                retrieveChartCallCount: 0,
                retrieveChartArgs: null,                documentEvidenceArgs: null,                documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,                evidenceRetrieverArgs: null,                evidenceRetrieverOutput: null,
    supervisorIterations: 0,
    supervisorDecisionHistory: [],
    capHit: false,
            }),
        ).rejects.toThrow(/draft|synthesi/i);
    });

    it('produces an empty-segments message when the draft contains no segments', async () => {
        // Edge case: the synthesizer should never emit zero segments
        // (the schema enforces min(1)), but `format` should not assume
        // it. An empty-segments message is preferable to a thrown error
        // because the failure-state UI can still render a bubble.
        const out = await format(baseState({ draft: { segments: [] } }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.segments).toEqual([]);
        expect(f.gaps).toEqual([]);
    });

    it('§4.1 attaches an empty suggestedFollowUps array when no claims qualify', async () => {
        const draft = draftSegments({ text: 'Type 2 diabetes (E11.9).', claimIds: ['dx-1'] });
        const out = await format(baseState({ draft }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.suggestedFollowUps).toEqual([]);
    });

    it('§4.1 populates suggestedFollowUps when an accepted lab claim links to a recognized analyte', async () => {
        const draft = draftSegments(
            { text: 'A1c is 8.4%.', claimIds: ['lab-1'] },
        );
        const out = await format(baseState({ draft, snapshot: snapshotWithA1cLab }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.suggestedFollowUps.length).toBeGreaterThan(0);
        const labTrend = f.suggestedFollowUps.find((s) => s.params.type === 'lab_trend');
        expect(labTrend).toBeDefined();
        if (labTrend?.params.type === 'lab_trend') {
            expect(labTrend.params.analyte).toBe('A1c');
        }
        expect(labTrend?.groundedInClaimIds).toContain('lab-1');
    });

    it('emits an empty suggestedFollowUps list on follow-up turns', async () => {
        // Suggested follow-ups make sense only on the default briefing —
        // the chips become the next turn's `followUp` envelope. Re-deriving
        // them on a follow-up turn produces a stale chip set the UI cannot
        // tie back to a default_briefing turn, so suppress at source.
        const draft = draftSegments(
            { text: 'A1c is 8.4%.', claimIds: ['lab-1'] },
        );
        const followUpEnvelope: RequestEnvelope = {
            ...envelope,
            task: 'follow_up',
            question: 'What was her last A1c?',
        };
        const out = await format(baseState({
            draft,
            snapshot: snapshotWithA1cLab,
            envelope: followUpEnvelope,
        }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.suggestedFollowUps).toEqual([]);
    });
});

// §C.6 — Format groups verified claims by `source_type` for the panel UI.
//
// The chat-bubble surface (`segments[]`) is unchanged; the new
// `claimGroups` field projects the same accepted claims into three
// optional sections so the panel renderer can chunk them without
// re-walking the snapshot. Empty sections are *absent* (not present-but-
// empty) so the renderer can naturally omit headers.
describe('format — claim groups by source_type (§C.6)', () => {
    const docSourceRef = (artifactId: string, page = 1, bbox: readonly [number, number, number, number] = [0.1, 0.1, 0.2, 0.05], documentUuid = 'doc-uuid-1') => ({
        source_type: 'extracted_document' as const,
        source_id: artifactId,
        locator: { page, bbox, field: 'results.0.value' },
        quote: '8.4 %',
        meta: { document_uuid: documentUuid, extractor_version: 'lab-pdf-v1' },
    });

    const guidelineSourceRef = (chunkId: string, section = 'recommendation-summary') => ({
        source_type: 'guideline' as const,
        source_id: chunkId,
        locator: { section },
        quote: 'Screen adults 45–75 for colorectal cancer.',
        meta: { rerank_score: 0.91 },
    });

    const docLabClaim: Claim = {
        id: 'doc-lab-1',
        text: 'Intake form lists A1c as 8.4%.',
        category: 'lab',
        sourceReferences: [docSourceRef('artifact-1')],
        safetyCritical: false,
    };

    const docAllergyClaim: Claim = {
        id: 'doc-alg-1',
        text: 'Intake form notes a penicillin allergy.',
        category: 'allergy',
        sourceReferences: [docSourceRef('artifact-2', 2, [0.2, 0.3, 0.3, 0.06], 'doc-uuid-2')],
        safetyCritical: true,
    };

    const guidelineClaim: Claim = {
        id: 'gl-1',
        text: 'USPSTF (2021) recommends colorectal cancer screening for adults 45–75 (Grade B).',
        category: 'reminder',
        sourceReferences: [guidelineSourceRef('uspstf::colorectal-cancer-screening--recommendation-summary')],
        safetyCritical: false,
    };

    it('groups accepted claims into chart / extractedDocument / guideline buckets', async () => {
        const verified: VerifiedLedger = {
            passed: true,
            accepted: [dxClaim, medClaim, allergyClaim, labClaim, docLabClaim, guidelineClaim],
            rejected: [],
            safetyHardStops: [],
        };
        const draft = draftSegments(
            { text: 'Type 2 diabetes (E11.9).', claimIds: ['dx-1'] },
            { text: 'Metformin 500 mg BID.', claimIds: ['med-1'] },
            { text: 'Penicillin allergy.', claimIds: ['alg-1'] },
            { text: 'A1c 8.4%.', claimIds: ['lab-1'] },
            { text: 'Intake form lists A1c as 8.4%.', claimIds: ['doc-lab-1'] },
            { text: 'USPSTF colorectal screening recommendation.', claimIds: ['gl-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.claimGroups).toBeDefined();

        // Chart bucket: W1-style claims, grouped by category in canonical order.
        const chart = f.claimGroups.chart;
        if (chart === undefined) throw new Error('chart group missing');
        const categoriesInOrder = chart.subsections.map((s) => s.category);
        // Canonical W1 order: diagnosis → prescription → allergy → lab.
        expect(categoriesInOrder).toEqual(['diagnosis', 'prescription', 'allergy', 'lab']);
        expect(chart.subsections.find((s) => s.category === 'diagnosis')?.claims.map((c) => c.id))
            .toEqual(['dx-1']);
        expect(chart.subsections.find((s) => s.category === 'lab')?.claims.map((c) => c.id))
            .toEqual(['lab-1']);

        // Extracted-document bucket: cards keyed by document_uuid.
        const docs = f.claimGroups.extractedDocument;
        if (docs === undefined) throw new Error('extractedDocument group missing');
        expect(docs.cards).toHaveLength(1);
        expect(docs.cards[0]?.documentUuid).toBe('doc-uuid-1');
        expect(docs.cards[0]?.claims.map((c) => c.id)).toEqual(['doc-lab-1']);

        // Guideline bucket: flat claim list.
        const guidelines = f.claimGroups.guideline;
        if (guidelines === undefined) throw new Error('guideline group missing');
        expect(guidelines.claims.map((c) => c.id)).toEqual(['gl-1']);
    });

    it('groups multiple extracted-document claims under one card per document_uuid', async () => {
        const verified: VerifiedLedger = {
            passed: true,
            accepted: [docLabClaim, docAllergyClaim],
            rejected: [],
            safetyHardStops: [],
        };
        const draft = draftSegments(
            { text: 'A1c 8.4%.', claimIds: ['doc-lab-1'] },
            { text: 'Penicillin allergy on intake.', claimIds: ['doc-alg-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        const docs = f.claimGroups.extractedDocument;
        if (docs === undefined) throw new Error('extractedDocument group missing');
        // Two distinct document_uuids → two cards, in first-seen order.
        expect(docs.cards.map((c) => c.documentUuid)).toEqual(['doc-uuid-1', 'doc-uuid-2']);
        expect(docs.cards[0]?.claims.map((c) => c.id)).toEqual(['doc-lab-1']);
        expect(docs.cards[1]?.claims.map((c) => c.id)).toEqual(['doc-alg-1']);
    });

    it('omits sections with no claims (no empty headers in the panel)', async () => {
        // No extracted-document or guideline claims this turn.
        const verified: VerifiedLedger = {
            passed: true,
            accepted: [dxClaim],
            rejected: [],
            safetyHardStops: [],
        };
        const draft = draftSegments({ text: 'Type 2 diabetes.', claimIds: ['dx-1'] });
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.claimGroups.chart).toBeDefined();
        expect(f.claimGroups.extractedDocument).toBeUndefined();
        expect(f.claimGroups.guideline).toBeUndefined();
    });

    it('places a mixed-source claim by its primary (first) sourceReference', async () => {
        // Mixed-source claim: primary ref is extracted_document, secondary
        // is guideline. Per C.6, the first ref wins — the claim lands in
        // the documents bucket, never duplicated.
        const mixedClaim: Claim = {
            id: 'mixed-1',
            text: 'Intake A1c is 8.4%; USPSTF recommends control under 7%.',
            category: 'lab',
            sourceReferences: [
                docSourceRef('artifact-1'),
                guidelineSourceRef('uspstf::diabetes-screening--recommendation-summary'),
            ],
            safetyCritical: false,
        };
        const verified: VerifiedLedger = {
            passed: true,
            accepted: [mixedClaim],
            rejected: [],
            safetyHardStops: [],
        };
        const draft = draftSegments(
            { text: 'Intake A1c 8.4%; USPSTF target <7%.', claimIds: ['mixed-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.claimGroups.extractedDocument?.cards[0]?.claims.map((c) => c.id))
            .toEqual(['mixed-1']);
        expect(f.claimGroups.guideline).toBeUndefined();
        expect(f.claimGroups.chart).toBeUndefined();
    });

    it('excludes hard-stop-suppressed claims from claimGroups even though they ride in `accepted`', async () => {
        // Allergies-unavailable suppresses prescription content in the
        // bubble; mirroring that in the panel keeps the two surfaces in
        // sync. The medClaim is in `accepted` but the panel must not
        // surface it because the hard stop fires.
        const verified: VerifiedLedger = {
            passed: false,
            accepted: [dxClaim, medClaim],
            rejected: [],
            safetyHardStops: ['allergies-unavailable'],
        };
        const draft = draftSegments(
            { text: 'Type 2 diabetes.', claimIds: ['dx-1'] },
            { text: 'Metformin 500 mg BID.', claimIds: ['med-1'] },
        );
        const out = await format(baseState({ draft, verified }));
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        const chart = f.claimGroups.chart;
        if (chart === undefined) throw new Error('chart group missing');
        const categories = chart.subsections.map((s) => s.category);
        // diagnosis present, prescription suppressed.
        expect(categories).toEqual(['diagnosis']);
    });
});
