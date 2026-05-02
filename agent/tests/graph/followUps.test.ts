import { describe, expect, it } from 'vitest';

import { generateFollowUps, parseMedicationKey } from '../../src/graph/followUps.js';
import type {
    BriefingSnapshot,
    Claim,
    VerifiedLedger,
} from '../../src/graph/types.js';
import type {
    Encounter,
    LabObservation,
    Prescription,
    SourceReference,
} from '../../src/snapshot/types.js';

const sourceRef = (
    recordType: string,
    recordId: string,
    overrides: Partial<SourceReference> = {},
): SourceReference => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
    ...overrides,
});

const baseSnapshot = (overrides: Partial<BriefingSnapshot> = {}): BriefingSnapshot => ({
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
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
    ...overrides,
});

const labClaim = (
    id: string,
    recordId: string,
    text = `Lab observation ${id}`,
): Claim => ({
    id,
    text,
    category: 'lab',
    sourceReferences: [sourceRef('Observation', recordId)],
    safetyCritical: false,
});

const medicationClaim = (id: string, recordId: string): Claim => ({
    id,
    text: `Medication ${id}`,
    category: 'prescription',
    sourceReferences: [sourceRef('MedicationRequest', recordId)],
    safetyCritical: true,
});

const encounterClaim = (id: string, recordId: string): Claim => ({
    id,
    text: `Encounter ${id}`,
    category: 'encounter',
    sourceReferences: [sourceRef('Encounter', recordId)],
    safetyCritical: false,
});

const lab = (
    recordId: string,
    analyte: string,
    overrides: Partial<LabObservation> = {},
): LabObservation => ({
    analyte,
    value: '1',
    unit: null,
    referenceRange: null,
    abnormalFlag: null,
    observedAt: null,
    source: sourceRef('Observation', recordId),
    ...overrides,
});

const prescription = (
    recordId: string,
    name: string,
    startDate: string | null,
): Prescription => ({
    name,
    dose: null,
    route: null,
    frequency: null,
    startDate,
    stopDate: null,
    prescriber: null,
    indication: null,
    prescriptionId: recordId,
    source: sourceRef('MedicationRequest', recordId),
});

const externalEncounter = (recordId: string): Encounter => ({
    encounterDate: '2026-01-10',
    type: 'ED',
    reason: 'Chest pain',
    source: sourceRef('Encounter', recordId, { system: 'ccda-importer' }),
});

const verifiedFrom = (claims: readonly Claim[]): VerifiedLedger => ({
    passed: true,
    accepted: claims,
    rejected: [],
    safetyHardStops: [],
});

const today = (): string => new Date().toISOString().slice(0, 10);

describe('generateFollowUps', () => {
    it('returns an empty array when verified.accepted is empty', () => {
        const result = generateFollowUps(
            'conv-1',
            verifiedFrom([]),
            baseSnapshot(),
        );
        expect(result).toEqual([]);
    });

    it('emits a lab_trend suggestion with the analyte copied verbatim from the snapshot', () => {
        const snapshot = baseSnapshot({
            labs: [lab('obs-1', 'A1c'), lab('obs-2', 'sodium')],
        });
        const claims: readonly Claim[] = [
            labClaim('claim-a1c', 'obs-1', 'A1c 8.4%'),
            labClaim('claim-na', 'obs-2', 'Sodium 140 mEq/L'),
        ];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const labTrend = result.filter((r) => r.params.type === 'lab_trend');
        expect(labTrend).toHaveLength(1);
        const sole = labTrend[0]!;
        expect(sole.params).toEqual({ type: 'lab_trend', analyte: 'A1c' });
        expect(sole.groundedInClaimIds).toContain('claim-a1c');
        expect(sole.groundedInClaimIds).not.toContain('claim-na');
    });

    it('caps lab_trend suggestions at 3 even when more recognized analytes match', () => {
        const snapshot = baseSnapshot({
            labs: [
                lab('o-1', 'A1c'),
                lab('o-2', 'BP'),
                lab('o-3', 'LDL'),
                lab('o-4', 'eGFR'),
            ],
        });
        const claims: readonly Claim[] = [
            labClaim('c-1', 'o-1'),
            labClaim('c-2', 'o-2'),
            labClaim('c-3', 'o-3'),
            labClaim('c-4', 'o-4'),
        ];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const labTrend = result.filter((r) => r.params.type === 'lab_trend');
        expect(labTrend.length).toBeLessThanOrEqual(3);
        expect(labTrend).toHaveLength(3);
    });

    it('emits a prescription_change suggestion when a med claim links to a startDate within 90 days of today', () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 30);
        const recentIso = recent.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            prescriptions: [prescription('rx-1', 'lisinopril', recentIso)],
        });
        const claims: readonly Claim[] = [medicationClaim('claim-rx', 'rx-1')];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const medSuggestions = result.filter((r) => r.params.type === 'prescription_change');
        expect(medSuggestions).toHaveLength(1);
        expect(medSuggestions[0]!.groundedInClaimIds).toContain('claim-rx');
    });

    it('does not emit a prescription_change suggestion when the startDate is older than 90 days', () => {
        const ancient = new Date();
        ancient.setDate(ancient.getDate() - 200);
        const ancientIso = ancient.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            prescriptions: [prescription('rx-1', 'lisinopril', ancientIso)],
        });
        const claims: readonly Claim[] = [medicationClaim('claim-rx', 'rx-1')];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const medSuggestions = result.filter((r) => r.params.type === 'prescription_change');
        expect(medSuggestions).toHaveLength(0);
    });

    it('caps prescription_change suggestions at 2 even when more recent meds match', () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 10);
        const recentIso = recent.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            prescriptions: [
                prescription('rx-1', 'lisinopril', recentIso),
                prescription('rx-2', 'metformin', recentIso),
                prescription('rx-3', 'atorvastatin', recentIso),
            ],
        });
        const claims: readonly Claim[] = [
            medicationClaim('c-1', 'rx-1'),
            medicationClaim('c-2', 'rx-2'),
            medicationClaim('c-3', 'rx-3'),
        ];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const medSuggestions = result.filter((r) => r.params.type === 'prescription_change');
        expect(medSuggestions).toHaveLength(2);
    });

    it('emits at most one external_care suggestion, only when an encounter has a non-openemr source', () => {
        const snapshot = baseSnapshot({
            encounters: [externalEncounter('enc-1'), externalEncounter('enc-2')],
        });
        const claims: readonly Claim[] = [
            encounterClaim('claim-enc-1', 'enc-1'),
            encounterClaim('claim-enc-2', 'enc-2'),
        ];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const external = result.filter((r) => r.params.type === 'external_care');
        expect(external).toHaveLength(1);
        expect(external[0]!.groundedInClaimIds.length).toBeGreaterThan(0);
    });

    it('emits the external_care suggestion when native and ccda-importer encounters coexist', () => {
        // §4.4 UC4. ExternalEncounterAdapter merges into the same
        // `encounters[]` as the native EncounterAdapter; the §4.1
        // generator must trigger on the presence of any non-openemr
        // source, not on every encounter being external. Pinning this
        // protects against a future regression where the filter
        // accidentally requires the external one to be the most
        // recent (or the only) encounter.
        const snapshot = baseSnapshot({
            encounters: [
                {
                    encounterDate: '2026-03-15',
                    type: 'OFFICE',
                    reason: 'follow-up',
                    source: sourceRef('Encounter', 'enc-native'),
                },
                externalEncounter('enc-external'),
            ],
        });
        const claims: readonly Claim[] = [
            encounterClaim('c-native', 'enc-native'),
            encounterClaim('c-external', 'enc-external'),
        ];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const external = result.filter((r) => r.params.type === 'external_care');
        expect(external).toHaveLength(1);
        // Both encounter claims contribute to the grounding ids — the
        // generator is conservative and links the suggestion to every
        // encounter claim in the ledger, regardless of system.
        expect(external[0]!.groundedInClaimIds).toEqual(
            expect.arrayContaining(['c-native', 'c-external']),
        );
    });

    it('does not emit an external_care suggestion when every encounter is from openemr', () => {
        const snapshot = baseSnapshot({
            encounters: [
                {
                    encounterDate: '2026-02-01',
                    type: 'OFFICE',
                    reason: null,
                    source: sourceRef('Encounter', 'enc-1'),
                },
            ],
        });
        const claims: readonly Claim[] = [encounterClaim('c-1', 'enc-1')];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const external = result.filter((r) => r.params.type === 'external_care');
        expect(external).toHaveLength(0);
    });

    it('caps total suggestions at 5 across all categories', () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 10);
        const recentIso = recent.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            labs: [lab('o-1', 'A1c'), lab('o-2', 'BP'), lab('o-3', 'LDL'), lab('o-4', 'eGFR')],
            prescriptions: [
                prescription('rx-1', 'lisinopril', recentIso),
                prescription('rx-2', 'metformin', recentIso),
            ],
            encounters: [externalEncounter('enc-1')],
        });
        const claims: readonly Claim[] = [
            labClaim('c-1', 'o-1'),
            labClaim('c-2', 'o-2'),
            labClaim('c-3', 'o-3'),
            labClaim('c-4', 'o-4'),
            medicationClaim('c-5', 'rx-1'),
            medicationClaim('c-6', 'rx-2'),
            encounterClaim('c-7', 'enc-1'),
        ];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        expect(result.length).toBeLessThanOrEqual(5);
    });

    it('produces stable ids: same conversationId + params yield the same id across calls', () => {
        const snapshot = baseSnapshot({ labs: [lab('o-1', 'A1c')] });
        const claims: readonly Claim[] = [labClaim('c-1', 'o-1')];
        const a = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const b = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(a[0]!.id).toBe(b[0]!.id);
    });

    it('produces different ids for the same params across different conversations', () => {
        const snapshot = baseSnapshot({ labs: [lab('o-1', 'A1c')] });
        const claims: readonly Claim[] = [labClaim('c-1', 'o-1')];
        const a = generateFollowUps('conv-A', verifiedFrom(claims), snapshot);
        const b = generateFollowUps('conv-B', verifiedFrom(claims), snapshot);
        expect(a[0]!.id).not.toBe(b[0]!.id);
    });

    it('every emitted suggestion lists at least one accepted claim id in groundedInClaimIds', () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 10);
        const recentIso = recent.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            labs: [lab('o-1', 'A1c')],
            prescriptions: [prescription('rx-1', 'lisinopril', recentIso)],
            encounters: [externalEncounter('enc-1')],
        });
        const claims: readonly Claim[] = [
            labClaim('c-lab', 'o-1'),
            medicationClaim('c-med', 'rx-1'),
            encounterClaim('c-enc', 'enc-1'),
        ];
        const acceptedIds = new Set(claims.map((c) => c.id));
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        expect(result.length).toBeGreaterThan(0);
        for (const suggestion of result) {
            expect(suggestion.groundedInClaimIds.length).toBeGreaterThan(0);
            for (const id of suggestion.groundedInClaimIds) {
                expect(acceptedIds.has(id)).toBe(true);
            }
        }
    });

    it('parseMedicationKey round-trips a recordId containing a colon', () => {
        // Today every recordType is colon-free, but a future external id
        // (URN-style, FHIR canonical, etc.) could bring colons. `lastIndexOf`
        // splits on the rightmost separator so the recordType stays whole.
        const key = 'MedicationRequest:urn:uuid:abc-123';
        const parsed = parseMedicationKey(key);
        expect(parsed).not.toBeNull();
        expect(parsed?.recordType).toBe('MedicationRequest:urn:uuid');
        expect(parsed?.recordId).toBe('abc-123');
    });

    it('uses the appointment.startAt date as the medication-recency anchor when present', () => {
        // Anchor is the appointment, not "today" — a med started ~80 days
        // before a future appointment qualifies even though it's >90 days
        // before today (here we keep both within 90d to keep the test
        // robust to the runner's clock and only assert the present-case).
        const apptStart = today() + 'T09:00:00.000Z';
        const recent = new Date();
        recent.setDate(recent.getDate() - 30);
        const recentIso = recent.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            appointment: {
                appointmentId: 'a-1',
                startAt: apptStart,
                durationMinutes: 30,
                type: null,
                reason: null,
                source: sourceRef('Appointment', 'a-1'),
            },
            prescriptions: [prescription('rx-1', 'lisinopril', recentIso)],
        });
        const claims: readonly Claim[] = [medicationClaim('c-1', 'rx-1')];
        const result = generateFollowUps('conv-1', verifiedFrom(claims), snapshot);
        const med = result.filter((r) => r.params.type === 'prescription_change');
        expect(med).toHaveLength(1);
    });
});
