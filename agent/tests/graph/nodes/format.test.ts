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
    retrieveChartArgs: null,    documentEvidenceArgs: null,    documentEvidenceSnippets: null,    evidenceRetrieverArgs: null,    evidenceRetrieverOutput: null,
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
                retrieveChartArgs: null,                documentEvidenceArgs: null,                documentEvidenceSnippets: null,                evidenceRetrieverArgs: null,                evidenceRetrieverOutput: null,
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
                retrieveChartArgs: null,                documentEvidenceArgs: null,                documentEvidenceSnippets: null,                evidenceRetrieverArgs: null,                evidenceRetrieverOutput: null,
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
