import { describe, expect, it } from 'vitest';

import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_MEDICATIONS_UNAVAILABLE,
    verifyLedger,
} from '../../src/verify/verifier.js';
import type { BriefingSnapshot, Claim, ClaimLedger } from '../../src/graph/types.js';

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const baseSnapshot = (overrides: Partial<BriefingSnapshot> = {}): BriefingSnapshot => ({
    patient: {
        pid: 42,
        uuid: 'p-uuid',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        source: sourceRef('Patient', '42'),
    },
    appointment: {
        appointmentId: 'apt-1',
        startAt: '2026-04-30T09:00:00+00:00',
        durationMinutes: 20,
        type: 'Office Visit',
        reason: 'Diabetes follow-up',
        source: sourceRef('Appointment', 'apt-1'),
    },
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: sourceRef('Condition', 'c-1'),
        },
    ],
    medications: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            source: sourceRef('MedicationRequest', 'rx-1'),
        },
    ],
    allergies: [
        {
            substance: 'Penicillin',
            reaction: 'Hives',
            severity: 'Moderate',
            source: sourceRef('AllergyIntolerance', 'a-1'),
        },
    ],
    labs: [
        {
            analyte: 'A1c',
            value: '8.4',
            unit: '%',
            referenceRange: '<7.0',
            abnormalFlag: 'H',
            observedAt: '2026-04-15',
            source: sourceRef('Observation', 'lab-1'),
        },
    ],
    encounters: [
        {
            encounterDate: '2026-03-01',
            type: 'Office Visit',
            reason: 'Diabetes follow-up',
            source: sourceRef('Encounter', 'enc-1'),
        },
    ],
    ...overrides,
});

const claim = (overrides: Partial<Claim>): Claim => ({
    id: overrides.id ?? 'c-1',
    text: overrides.text ?? 'unspecified',
    category: overrides.category ?? 'diagnosis',
    sourceReferences: overrides.sourceReferences ?? [sourceRef('Condition', 'c-1')],
    safetyCritical: overrides.safetyCritical ?? false,
});

const single = (c: Claim): ClaimLedger => ({ claims: [c] });

describe('verifyLedger — required source references', () => {
    it('rejects a claim with zero source references', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(claim({ sourceReferences: [] })),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected).toHaveLength(1);
        expect(out.rejected[0]?.reason).toBe('missing-source-references');
        expect(out.passed).toBe(false);
    });

    it('rejects a claim whose source ref does not resolve to a snapshot record', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'diagnosis',
                    text: 'Type 2 diabetes (E11.9)',
                    sourceReferences: [sourceRef('Condition', 'c-MISSING')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});

describe('verifyLedger — deterministic checks per category', () => {
    it('accepts a medication claim that names the cited drug', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'medication',
                    text: 'Patient is on Metformin 500 mg twice daily',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.passed).toBe(true);
    });

    it('rejects a medication claim that names a different drug than the cited one', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'medication',
                    text: 'Patient is on Lisinopril 10 mg daily',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('accepts a lab claim that mentions both analyte and value', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'A1c was 8.4% on 2026-04-15',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('rejects a lab claim missing the value (cannot fabricate numbers)', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'A1c is trending upward',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('accepts an allergy claim that names the substance', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'allergy',
                    text: 'Penicillin causes hives',
                    sourceReferences: [sourceRef('AllergyIntolerance', 'a-1')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('accepts a diagnosis claim that mentions either ICD code or label', () => {
        const byCode = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'diagnosis',
                    text: 'Active dx: E11.9',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                }),
            ),
        );
        const byLabel = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'diagnosis',
                    text: 'Active dx: type 2 diabetes',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                }),
            ),
        );
        expect(byCode.accepted).toHaveLength(1);
        expect(byLabel.accepted).toHaveLength(1);
    });

    it('accepts an encounter claim that mentions date or type', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'encounter',
                    text: '2026-03-01: prior visit',
                    sourceReferences: [sourceRef('Encounter', 'enc-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('accepts an appointment claim when the appointment id matches', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'appointment',
                    text: 'Today: Office Visit at 09:00',
                    sourceReferences: [sourceRef('Appointment', 'apt-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('rejects an appointment claim citing an appointment that is not in scope', () => {
        const out = verifyLedger(
            baseSnapshot({ appointment: null }),
            single(
                claim({
                    category: 'appointment',
                    text: 'Today: Office Visit',
                    sourceReferences: [sourceRef('Appointment', 'apt-1')],
                }),
            ),
        );
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('accepts an identity claim citing the patient record', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'identity',
                    text: 'Patient: Patel, Maya',
                    sourceReferences: [sourceRef('Patient', '42')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });
});

describe('verifyLedger — hard clinical rules (fail closed)', () => {
    it('drops every medication claim and reports a hard stop when allergies are unavailable', () => {
        // The current `BriefingSnapshot` shape never carries an allergy gap
        // — Retrieve fails the whole graph if `getPatientContext` errors —
        // but the verifier treats a structurally-shaped allergy gap as the
        // safety boundary. Forcing the gap shape here pins the policy
        // independent of the upstream type so a future widening cannot
        // regress fail-closed behavior.
        const snapshot = baseSnapshot({
            allergies: { kind: 'gap', reason: 'unavailable', message: 'allergies unreachable' } as never,
        });
        const out = verifyLedger(
            snapshot,
            single(
                claim({
                    category: 'medication',
                    text: 'Metformin 500 mg BID',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('safety-critical-data-unavailable');
        expect(out.safetyHardStops).toContain(HARD_STOP_ALLERGIES_UNAVAILABLE);
        expect(out.passed).toBe(false);
    });

    it('drops every medication claim when medications themselves are unavailable', () => {
        const snapshot = baseSnapshot({
            medications: { kind: 'gap', reason: 'unavailable', message: 'meds unreachable' } as never,
        });
        const out = verifyLedger(
            snapshot,
            single(
                claim({
                    category: 'medication',
                    text: 'Metformin 500 mg BID',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.rejected[0]?.reason).toBe('safety-critical-data-unavailable');
        expect(out.safetyHardStops).toContain(HARD_STOP_MEDICATIONS_UNAVAILABLE);
    });

    it('passes for non-medication claims even when allergies are unavailable', () => {
        // Diabetic-Hypertensive UC1 path — if allergies are missing we
        // hide the medication summary, but a diagnosis claim sourced from
        // the Condition list is still safe to surface.
        const snapshot = baseSnapshot({
            allergies: { kind: 'gap', reason: 'unavailable', message: 'allergies unreachable' } as never,
        });
        const out = verifyLedger(
            snapshot,
            single(
                claim({
                    category: 'diagnosis',
                    text: 'E11.9',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        // hard stop is still recorded even though this claim wasn't
        // affected — Format/Persist can read it to suppress the medication
        // section.
        expect(out.safetyHardStops).toContain(HARD_STOP_ALLERGIES_UNAVAILABLE);
        expect(out.passed).toBe(false);
    });

    it('returns passed=true only when no rejections and no hard stops', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'diagnosis',
                    text: 'E11.9',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                }),
            ),
        );
        expect(out.passed).toBe(true);
    });
});

describe('verifyLedger — multiple claims', () => {
    it('partitions a mixed ledger into accepted and rejected', () => {
        const ledger: ClaimLedger = {
            claims: [
                claim({
                    id: 'good-dx',
                    category: 'diagnosis',
                    text: 'E11.9 type 2 diabetes',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                }),
                claim({
                    id: 'bad-no-source',
                    category: 'medication',
                    text: 'Metformin 500 mg',
                    sourceReferences: [],
                }),
                claim({
                    id: 'bad-unresolved',
                    category: 'lab',
                    text: 'A1c 8.4%',
                    sourceReferences: [sourceRef('Observation', 'lab-DOES-NOT-EXIST')],
                }),
                claim({
                    id: 'good-med',
                    category: 'medication',
                    text: 'Metformin 500 mg BID',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                }),
            ],
        };
        const out = verifyLedger(baseSnapshot(), ledger);
        expect(out.accepted.map((c) => c.id).sort()).toEqual(['good-dx', 'good-med']);
        expect(out.rejected.map((r) => r.claim.id).sort()).toEqual([
            'bad-no-source',
            'bad-unresolved',
        ]);
    });
});
