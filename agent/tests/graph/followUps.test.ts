import { describe, expect, it } from 'vitest';

import { generateFollowUps } from '../../src/graph/followUps.js';
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

const sourceRef = (
    recordType: string,
    recordId: string,
    overrides: Partial<SourceReference> = {},
): SourceReference => ({
    source_type: 'chart',
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
    ...overrides,
});

const baseSnapshot = (overrides: Partial<BriefingSnapshot> = {}): BriefingSnapshot => ({
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
    source: sourceRef('Encounter', recordId),
});

const verifiedFrom = (claims: readonly Claim[]): VerifiedLedger => ({
    passed: true,
    accepted: claims,
    rejected: [],
    safetyHardStops: [],
});

const today = (): string => new Date().toISOString().slice(0, 10);

const isLabTrend = (text: string): boolean => /trending/i.test(text);
const isPrescriptionAsk = (text: string): boolean => /^Why was .* prescribed\?$/i.test(text);
const isExternalEncounter = (text: string): boolean => /outside encounter/i.test(text);

describe('generateFollowUps', () => {
    it('returns an empty array when verified.accepted is empty', () => {
        const result = generateFollowUps(verifiedFrom([]), baseSnapshot());
        expect(result).toEqual([]);
    });

    it('emits a lab-trend chip whose text names the analyte verbatim', () => {
        const snapshot = baseSnapshot({
            labs: [lab('obs-1', 'A1c'), lab('obs-2', 'sodium')],
        });
        const claims: readonly Claim[] = [
            labClaim('claim-a1c', 'obs-1', 'A1c 8.4%'),
            labClaim('claim-na', 'obs-2', 'Sodium 140 mEq/L'),
        ];
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const labTrend = result.filter((r) => isLabTrend(r.displayText));
        expect(labTrend).toHaveLength(1);
        const sole = labTrend[0]!;
        expect(sole.displayText).toContain('A1c');
        expect(sole.groundedInClaimIds).toContain('claim-a1c');
        expect(sole.groundedInClaimIds).not.toContain('claim-na');
    });

    it('caps lab-trend chips at 3 even when more recognized analytes match', () => {
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const labTrend = result.filter((r) => isLabTrend(r.displayText));
        expect(labTrend).toHaveLength(3);
    });

    it('emits a prescription chip when a med claim links to a startDate within 90 days of today', () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 30);
        const recentIso = recent.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            prescriptions: [prescription('rx-1', 'lisinopril', recentIso)],
        });
        const claims: readonly Claim[] = [medicationClaim('claim-rx', 'rx-1')];
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const medSuggestions = result.filter((r) => isPrescriptionAsk(r.displayText));
        expect(medSuggestions).toHaveLength(1);
        expect(medSuggestions[0]!.displayText).toContain('lisinopril');
        expect(medSuggestions[0]!.groundedInClaimIds).toContain('claim-rx');
    });

    it('does not emit a prescription chip when the startDate is older than 90 days', () => {
        const ancient = new Date();
        ancient.setDate(ancient.getDate() - 200);
        const ancientIso = ancient.toISOString().slice(0, 10);
        const snapshot = baseSnapshot({
            prescriptions: [prescription('rx-1', 'lisinopril', ancientIso)],
        });
        const claims: readonly Claim[] = [medicationClaim('claim-rx', 'rx-1')];
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const medSuggestions = result.filter((r) => isPrescriptionAsk(r.displayText));
        expect(medSuggestions).toHaveLength(0);
    });

    it('caps prescription chips at 2 even when more recent meds match', () => {
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const medSuggestions = result.filter((r) => isPrescriptionAsk(r.displayText));
        expect(medSuggestions).toHaveLength(2);
    });

    it('emits at most one outside-encounter chip when external encounters exist', () => {
        const snapshot = baseSnapshot({
            encounters: [externalEncounter('enc-1'), externalEncounter('enc-2')],
        });
        const claims: readonly Claim[] = [
            encounterClaim('claim-enc-1', 'enc-1'),
            encounterClaim('claim-enc-2', 'enc-2'),
        ];
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const external = result.filter((r) => isExternalEncounter(r.displayText));
        expect(external).toHaveLength(1);
        expect(external[0]!.groundedInClaimIds.length).toBeGreaterThan(0);
    });

    it('emits the outside-encounter chip when native and external encounters coexist', () => {
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const external = result.filter((r) => isExternalEncounter(r.displayText));
        expect(external).toHaveLength(1);
        // Both encounter claims contribute to the grounding ids — the
        // generator is conservative and links the suggestion to every
        // encounter claim in the ledger, regardless of system.
        expect(external[0]!.groundedInClaimIds).toEqual(
            expect.arrayContaining(['c-native', 'c-external']),
        );
    });

    it('does not emit an outside-encounter chip when every encounter is an office visit', () => {
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const external = result.filter((r) => isExternalEncounter(r.displayText));
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        expect(result.length).toBeLessThanOrEqual(5);
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        expect(result.length).toBeGreaterThan(0);
        for (const suggestion of result) {
            expect(suggestion.groundedInClaimIds.length).toBeGreaterThan(0);
            for (const id of suggestion.groundedInClaimIds) {
                expect(acceptedIds.has(id)).toBe(true);
            }
        }
    });

    it('uses the appointment.startAt date as the medication-recency anchor when present', () => {
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
        const result = generateFollowUps(verifiedFrom(claims), snapshot);
        const med = result.filter((r) => isPrescriptionAsk(r.displayText));
        expect(med).toHaveLength(1);
    });
});
