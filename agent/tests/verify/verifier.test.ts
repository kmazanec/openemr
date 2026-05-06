import { describe, expect, it } from 'vitest';

import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_PRESCRIPTIONS_UNAVAILABLE,
    verifyLedger,
} from '../../src/verify/verifier.js';
import type {
    BriefingSnapshot,
    Claim,
    ClaimLedger,
    EvidenceSnippet,
    ExtractedFactSnippet,
} from '../../src/graph/types.js';

// Maps the W1 FHIR resource type the existing test cases pass to the
// W2 `locator.field` value the unified shape requires for `chart`
// citations. Keeping the test signature W1-shaped lets each test case
// stay readable even though the constructed SourceReference is W2.
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

const sourceRef = (recordType: string, recordId: string, _system = 'openemr') => {
    const field = FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record';
    return {
        source_type: 'chart' as const,
        source_id: recordId,
        locator: { field },
        quote: recordId,
    };
};

const baseSnapshot = (overrides: Partial<BriefingSnapshot> = {}): BriefingSnapshot => ({
    patient: {
        pid: 42,
        uuid: 'p-uuid',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        ageYears: 58,
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
    prescriptions: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Patel',
            indication: null,
            prescriptionId: 'rx-1',
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
    reminders: [],
    medications: [],
    labHistory: null,
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
                    category: 'prescription',
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
                    category: 'prescription',
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

    /**
     * NKDA records carry the substance literal `"NKDA"` rather than a
     * real allergen. Forcing the claim text to literally include
     * "NKDA" would reject every accurately-paraphrased "no known drug
     * allergies" statement (which is what Haiku produced when the
     * §3.6 hypertensive eval first ran). The verifier handles NKDA
     * specially against a small allow-list of phrasings — these
     * tests pin the closed set.
     */
    const nkdaSnapshot = (): BriefingSnapshot =>
        baseSnapshot({
            allergies: [
                {
                    substance: 'NKDA',
                    reaction: null,
                    severity: null,
                    source: sourceRef('AllergyIntolerance', 'a-nkda'),
                },
            ],
        });

    it.each([
        'No known drug allergies',
        'NKDA',
        'Patient has no known allergies on file',
        'Allergies: none reported',
        'Patient denies drug allergies',
        'No reported allergies',
    ])('accepts NKDA-shaped allergy claim: %s', (text) => {
        const out = verifyLedger(
            nkdaSnapshot(),
            single(
                claim({
                    category: 'allergy',
                    text,
                    sourceReferences: [sourceRef('AllergyIntolerance', 'a-nkda')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.rejected).toHaveLength(0);
    });

    it.each([
        'Penicillin causes hives',
        'No penicillin allergy',
        'Allergic to sulfa',
    ])('rejects a non-NKDA-shaped claim grounded against an NKDA record: %s', (text) => {
        const out = verifyLedger(
            nkdaSnapshot(),
            single(
                claim({
                    category: 'allergy',
                    text,
                    sourceReferences: [sourceRef('AllergyIntolerance', 'a-nkda')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected).toHaveLength(1);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
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

    it('resolves external (ccda-importer) encounters in the same index as native ones', () => {
        // §4.4 UC4. ExternalEncounterAdapter (PHP side) emits Encounter
        // DTOs with `source.system = 'ccda-importer'`; the merged
        // snapshot includes them in `encounters[]`. The verifier indexes
        // by `recordId` regardless of system, so a faithful claim
        // citing an external encounter resolves and matches just like a
        // native one. This test pins that contract — drop it and a
        // future filter on `system === 'openemr'` would silently break
        // UC4 without any other test failing.
        const snapshot = baseSnapshot({
            encounters: [
                {
                    encounterDate: '2026-04-22',
                    type: 'St. Mary ED',
                    reason: 'Chest pain - discharged after negative workup',
                    source: sourceRef('Encounter', 'ext-7', 'ccda-importer'),
                },
            ],
        });
        const out = verifyLedger(
            snapshot,
            single(
                claim({
                    category: 'encounter',
                    text: 'External ED visit on 2026-04-22 for chest pain',
                    sourceReferences: [sourceRef('Encounter', 'ext-7', 'ccda-importer')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.rejected).toEqual([]);
    });

    it('rejects a claim citing an external encounter id that is not in the snapshot', () => {
        // Companion to the resolution test: the `recordId` is the
        // primary key the adapter emits (`ee_id`). A fabricated id
        // (even with the correct `system`) must reject.
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'encounter',
                    text: 'Outside ED visit on 2026-04-22',
                    sourceReferences: [sourceRef('Encounter', 'ext-does-not-exist', 'ccda-importer')],
                }),
            ),
        );
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
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

// §4.3: prescription_change requires the claim to surface the documented
// prescriber + indication (when those fields are non-null in the source
// row). The deterministic prescriptionChangeBranch builds these claims; the rule
// is the gate that prevents a model regression from fabricating either.
describe('verifyLedger — prescription_change category (§4.3 UC3)', () => {
    const provSnapshot = (med: { prescriber: string | null; indication: string | null }) =>
        baseSnapshot({
            prescriptions: [
                {
                    name: 'Lisinopril',
                    dose: '10 mg',
                    route: 'PO',
                    frequency: 'daily',
                    startDate: '2026-03-20',
                    stopDate: null,
                    prescriber: med.prescriber,
                    indication: med.indication,
                    prescriptionId: 'rx-7001',
                    source: sourceRef('MedicationRequest', 'rx-7001'),
                },
            ],
        });

    it('accepts when name + prescriber + indication all appear in the claim text', () => {
        const out = verifyLedger(
            provSnapshot({ prescriber: 'Patel, Maya', indication: 'new-onset hypertension' }),
            single(
                claim({
                    category: 'prescription_change',
                    text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Patel, Maya for new-onset hypertension.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-7001')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.passed).toBe(true);
    });

    it('rejects when the source has an indication but the claim text omits it', () => {
        const out = verifyLedger(
            provSnapshot({ prescriber: 'Patel, Maya', indication: 'new-onset hypertension' }),
            single(
                claim({
                    category: 'prescription_change',
                    text: 'Lisinopril 10 mg, started 2026-03-20, prescribed by Patel, Maya.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-7001')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects when the source has a prescriber but the claim text omits it', () => {
        const out = verifyLedger(
            provSnapshot({ prescriber: 'Patel, Maya', indication: null }),
            single(
                claim({
                    category: 'prescription_change',
                    text: 'Lisinopril 10 mg, started 2026-03-20.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-7001')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('accepts a name-only claim when both prescriber and indication are null in the source', () => {
        const out = verifyLedger(
            provSnapshot({ prescriber: null, indication: null }),
            single(
                claim({
                    category: 'prescription_change',
                    text: 'Lisinopril 10 mg, started 2026-03-20.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-7001')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.passed).toBe(true);
    });

    it('rejects when the cited prescription is not in the snapshot', () => {
        const out = verifyLedger(
            provSnapshot({ prescriber: 'Patel, Maya', indication: 'new-onset hypertension' }),
            single(
                claim({
                    category: 'prescription_change',
                    text: 'Lisinopril 10 mg, prescribed by Patel, Maya for new-onset hypertension.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-MISSING')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
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
                    category: 'prescription',
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

    it('drops every medication claim when prescriptions themselves are unavailable', () => {
        const snapshot = baseSnapshot({
            prescriptions: { kind: 'gap', reason: 'unavailable', message: 'meds unreachable' } as never,
        });
        const out = verifyLedger(
            snapshot,
            single(
                claim({
                    category: 'prescription',
                    text: 'Metformin 500 mg BID',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.rejected[0]?.reason).toBe('safety-critical-data-unavailable');
        expect(out.safetyHardStops).toContain(HARD_STOP_PRESCRIPTIONS_UNAVAILABLE);
    });

    it('also suppresses prescription_change claims when the safety stop fires', () => {
        // Same fail-closed parity as the medication category — a
        // medication-change claim is medication content under any
        // reasonable taxonomy, so the allergies-unavailable hard stop
        // suppresses it too.
        const snapshot = baseSnapshot({
            allergies: { kind: 'gap', reason: 'unavailable', message: 'allergies unreachable' } as never,
        });
        const out = verifyLedger(
            snapshot,
            single(
                claim({
                    category: 'prescription_change',
                    text: 'Metformin 500 mg, prescribed by Dr. Patel.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                    safetyCritical: true,
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('safety-critical-data-unavailable');
        expect(out.safetyHardStops).toContain(HARD_STOP_ALLERGIES_UNAVAILABLE);
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
                    category: 'prescription',
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
                    category: 'prescription',
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

describe('verifyLedger — §4.2 UC2 strengthened lab rule', () => {
    const labRow = (
        recordId: string,
        value: string,
        observedAt: string,
        unit: string | null = '%',
    ) => ({
        analyte: 'Hemoglobin A1c',
        value,
        unit,
        referenceRange: '4.0-5.6',
        abnormalFlag: 'H' as const,
        observedAt,
        source: sourceRef('Observation', recordId),
    });

    const trendSnapshot = () =>
        baseSnapshot({
            labHistory: {
                analyte: 'Hemoglobin A1c',
                observations: [
                    labRow('lab-h1', '7.2', '2024-04-15'),
                    labRow('lab-h2', '8.1', '2025-04-15'),
                    labRow('lab-h3', '9.4', '2026-04-15'),
                ],
            },
        });

    it('regression: accepts a single-value lab claim with no date and no unit token', () => {
        // Pre-§4.2 behavior — a claim with just analyte + value still
        // passes when no date or unit is mentioned. The UC1 briefing
        // path emits these.
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    id: 'l-single',
                    category: 'lab',
                    text: 'A1c 8.4',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('accepts a two-value trend claim where each value/date matches its source row', () => {
        const out = verifyLedger(
            trendSnapshot(),
            single(
                claim({
                    id: 'l-trend',
                    category: 'lab',
                    text: 'Hemoglobin A1c rose from 7.2 on 2024-04-15 to 9.4 on 2026-04-15.',
                    sourceReferences: [
                        sourceRef('Observation', 'lab-h1'),
                        sourceRef('Observation', 'lab-h3'),
                    ],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.rejected).toHaveLength(0);
    });

    it('rejects a trend claim where one cited value\'s date does not match its row', () => {
        // Row lab-h1 is observedAt 2024-04-15. The claim mentions
        // 2024-05-15 — wrong date for the cited row, even though the
        // value matches.
        const out = verifyLedger(
            trendSnapshot(),
            single(
                claim({
                    id: 'l-bad-date',
                    category: 'lab',
                    text: 'Hemoglobin A1c rose from 7.2 on 2024-05-15 to 9.4 on 2026-04-15.',
                    sourceReferences: [
                        sourceRef('Observation', 'lab-h1'),
                        sourceRef('Observation', 'lab-h3'),
                    ],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects a trend claim where one cited value\'s unit is wrong', () => {
        // Row unit is '%'; claim writes 'mg/dL' adjacent to the value.
        const out = verifyLedger(
            trendSnapshot(),
            single(
                claim({
                    id: 'l-bad-unit',
                    category: 'lab',
                    text: 'Hemoglobin A1c rose from 7.2% on 2024-04-15 to 9.4 mg/dL on 2026-04-15.',
                    sourceReferences: [
                        sourceRef('Observation', 'lab-h1'),
                        sourceRef('Observation', 'lab-h3'),
                    ],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('accepts a trend claim that omits the unit (asymmetric rule)', () => {
        // No unit-shaped token adjacent to the values — the rule is
        // "if you write a unit, write the right one", not "every
        // claim must carry a unit".
        const out = verifyLedger(
            trendSnapshot(),
            single(
                claim({
                    id: 'l-no-unit',
                    category: 'lab',
                    text: 'Hemoglobin A1c rose from 7.2 on 2024-04-15 to 9.4 on 2026-04-15.',
                    sourceReferences: [
                        sourceRef('Observation', 'lab-h1'),
                        sourceRef('Observation', 'lab-h3'),
                    ],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('rejects a trend claim that mixes a real source ref with a fabricated one', () => {
        // §4.2 multi-ref enforcement: pre-strengthening, the verifier
        // would have accepted this because at least one ref resolved.
        // Now every cited ref must resolve.
        const out = verifyLedger(
            trendSnapshot(),
            single(
                claim({
                    id: 'l-mixed',
                    category: 'lab',
                    text: 'Hemoglobin A1c rose from 7.2 on 2024-04-15 to 9.4 on 2026-04-15.',
                    sourceReferences: [
                        sourceRef('Observation', 'lab-h1'),
                        sourceRef('Observation', 'lab-FABRICATED'),
                    ],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('resolves trend claims against snapshot.labHistory rows (separate slot from snapshot.labs)', () => {
        // The trend rows live in `labHistory.observations`, not
        // `snapshot.labs`. The verifier must index both into the
        // shared lookup so a trend citation resolves the same way
        // a single-value briefing citation does.
        const out = verifyLedger(
            trendSnapshot(),
            single(
                claim({
                    id: 'l-history-only',
                    category: 'lab',
                    text: 'Hemoglobin A1c was 8.1 on 2025-04-15.',
                    sourceReferences: [sourceRef('Observation', 'lab-h2')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });
});

describe('verifyLedger — source_type dispatch (chart carry-forward)', () => {
    // C.5 added the `extracted_document` and `guideline` paths; the
    // chart path still works. The §A.8 NotYetImplementedError stub
    // tests are gone (the union is closed at compile time, so a
    // "future-unhandled source_type" test would need an `as never`
    // hack and isn't reachable in practice).
    it('still accepts chart-type citations under the C.5 dispatch (W1 carry-forward)', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'diagnosis',
                    text: 'Type 2 diabetes (E11.9)',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                }),
            ),
        );
        expect(out.passed).toBe(true);
        expect(out.accepted).toHaveLength(1);
    });
});

// §C.5: per-`source_type` resolution rules for `extracted_document`.
// Architecture (`W2_ARCHITECTURE.md` §"Verifier resolution rules"):
// - `source_id` must be in this turn's document-evidence retriever
//   output snippets (the actual state slot is
//   `state.documentEvidenceSnippets`; the architecture text reads
//   "extraction_artifacts" but that's the source-of-truth table —
//   the verifier resolves against the snippets the retriever
//   produced this turn).
// - `locator.page` and `locator.bbox` must equal the snippet's
//   recorded values (no fabricated bboxes).
// - `quote` substring-matches the snippet's recorded quote (or its
//   stringified value at `locator.field`).
describe('verifyLedger — extracted_document source_type (§C.5)', () => {
    const extractedRef = (
        sourceId: string,
        opts: {
            readonly fieldPath: string;
            readonly page: number;
            readonly bbox: readonly [number, number, number, number];
            readonly quote: string;
        },
    ) => ({
        source_type: 'extracted_document' as const,
        source_id: sourceId,
        locator: {
            page: opts.page,
            bbox: opts.bbox as [number, number, number, number],
            field: opts.fieldPath,
        },
        quote: opts.quote,
    });

    const a1cSnippet: ExtractedFactSnippet = {
        artifactId: 'art-lab-1',
        documentUuid: 'doc-uuid-1',
        docType: 'lab_pdf',
        fieldPath: 'results.0.value',
        value: '9.4',
        page: 1,
        bbox: [10, 20, 200, 40],
        quote: 'A1c 9.4 % (H)',
        confidence: 0.95,
        extractorVersion: 'v1',
        createdAt: '2026-04-15T10:00:00Z',
    };

    it('accepts an extracted_document claim whose locator matches the snippet exactly', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'Recent intake form shows A1c 9.4',
                    sourceReferences: [
                        extractedRef('art-lab-1', {
                            fieldPath: 'results.0.value',
                            page: 1,
                            bbox: [10, 20, 200, 40],
                            quote: 'A1c 9.4',
                        }),
                    ],
                }),
            ),
            { documentEvidenceSnippets: [a1cSnippet] },
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.passed).toBe(true);
    });

    it('rejects an extracted_document claim whose source_id is not in this turn\'s snippets', () => {
        // The whole point: model named an artifact id that the
        // retriever didn't return this turn → fabricated citation.
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'A1c 9.4 from intake',
                    sourceReferences: [
                        extractedRef('art-FABRICATED', {
                            fieldPath: 'results.0.value',
                            page: 1,
                            bbox: [10, 20, 200, 40],
                            quote: 'A1c 9.4',
                        }),
                    ],
                }),
            ),
            { documentEvidenceSnippets: [a1cSnippet] },
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('rejects an extracted_document claim with a fabricated bbox', () => {
        // Snippet bbox is [10, 20, 200, 40]; claim writes a different
        // bbox. Bbox spoofing is the exact failure mode the §C.5
        // architecture text calls out ("no fabricated bboxes").
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'A1c 9.4',
                    sourceReferences: [
                        extractedRef('art-lab-1', {
                            fieldPath: 'results.0.value',
                            page: 1,
                            bbox: [99, 99, 99, 99],
                            quote: 'A1c 9.4',
                        }),
                    ],
                }),
            ),
            { documentEvidenceSnippets: [a1cSnippet] },
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects an extracted_document claim with a wrong page number', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'A1c 9.4',
                    sourceReferences: [
                        extractedRef('art-lab-1', {
                            fieldPath: 'results.0.value',
                            page: 7,
                            bbox: [10, 20, 200, 40],
                            quote: 'A1c 9.4',
                        }),
                    ],
                }),
            ),
            { documentEvidenceSnippets: [a1cSnippet] },
        );
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects an extracted_document claim whose quote does not substring-match the snippet text or value', () => {
        // The snippet quote is "A1c 9.4 % (H)" and value is "9.4".
        // The claim says "A1c 5.5" — neither substring matches.
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'A1c 5.5',
                    sourceReferences: [
                        extractedRef('art-lab-1', {
                            fieldPath: 'results.0.value',
                            page: 1,
                            bbox: [10, 20, 200, 40],
                            quote: 'A1c 5.5',
                        }),
                    ],
                }),
            ),
            { documentEvidenceSnippets: [a1cSnippet] },
        );
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects an extracted_document claim whose locator.field points at a different snippet on the same artifact', () => {
        // Same artifact has two snippets at two field paths. The
        // claim cites field `results.1.value` but its bbox is the one
        // for `results.0.value` — the locator must resolve to a
        // *single* snippet whose page+bbox match.
        const a1cSnippet2: ExtractedFactSnippet = {
            ...a1cSnippet,
            fieldPath: 'results.1.value',
            value: '180',
            bbox: [10, 80, 200, 100],
            quote: 'Glucose 180 mg/dL',
        };
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'Glucose 180',
                    sourceReferences: [
                        extractedRef('art-lab-1', {
                            fieldPath: 'results.1.value',
                            page: 1,
                            bbox: [10, 20, 200, 40], // ← bbox of results.0, not results.1
                            quote: 'Glucose 180',
                        }),
                    ],
                }),
            ),
            { documentEvidenceSnippets: [a1cSnippet, a1cSnippet2] },
        );
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });
});

// §C.5: per-`source_type` resolution rules for `guideline`.
describe('verifyLedger — guideline source_type (§C.5)', () => {
    const guidelineRef = (sourceId: string, section: string, quote: string) => ({
        source_type: 'guideline' as const,
        source_id: sourceId,
        locator: { section },
        quote,
    });

    const colorectalSnippet: EvidenceSnippet = {
        chunkId: 'uspstf::colorectal-cancer-screening--recommendation-summary',
        publication: 'USPSTF',
        year: 2021,
        section: 'recommendation-summary',
        title: 'Colorectal Cancer: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening',
        licenseTier: 'public_domain',
        quote:
            'The USPSTF recommends screening for colorectal cancer in adults aged 45 to 75 years. Grade B.',
        rerankScore: 0.92,
        degradedRerank: false,
    };

    const evidenceOutput = (snippets: readonly EvidenceSnippet[]) => ({
        snippets,
        gap: null,
    });

    it('accepts a guideline claim whose chunk_id resolves and whose quote substring-matches the snippet', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'reminder',
                    text: 'USPSTF recommends colorectal screening in adults aged 45 to 75.',
                    sourceReferences: [
                        guidelineRef(
                            'uspstf::colorectal-cancer-screening--recommendation-summary',
                            'recommendation-summary',
                            'screening for colorectal cancer in adults aged 45 to 75',
                        ),
                    ],
                }),
            ),
            { evidenceRetrieverOutput: evidenceOutput([colorectalSnippet]) },
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.passed).toBe(true);
    });

    it('rejects a guideline claim whose chunk_id is not in this turn\'s retriever output', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'reminder',
                    text: 'USPSTF says colorectal screening is recommended.',
                    sourceReferences: [
                        guidelineRef(
                            'uspstf::FABRICATED-chunk-id',
                            'recommendation-summary',
                            'screening for colorectal cancer',
                        ),
                    ],
                }),
            ),
            { evidenceRetrieverOutput: evidenceOutput([colorectalSnippet]) },
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('rejects a guideline claim whose locator.section does not match the snippet', () => {
        // The snippet is in section `recommendation-summary`; the
        // claim names section `clinical-considerations` — same
        // recommendation, different chunk. Without a section check,
        // the model could cite a chunk from one section but quote
        // text actually only present in another.
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'reminder',
                    text: 'USPSTF recommends colorectal screening at 45.',
                    sourceReferences: [
                        guidelineRef(
                            'uspstf::colorectal-cancer-screening--recommendation-summary',
                            'clinical-considerations',
                            'screening for colorectal cancer',
                        ),
                    ],
                }),
            ),
            { evidenceRetrieverOutput: evidenceOutput([colorectalSnippet]) },
        );
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects a guideline claim whose quote is not a substring of the snippet text', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'reminder',
                    text: 'USPSTF recommends colonoscopy every 5 years.',
                    sourceReferences: [
                        guidelineRef(
                            'uspstf::colorectal-cancer-screening--recommendation-summary',
                            'recommendation-summary',
                            'colonoscopy every 5 years',
                        ),
                    ],
                }),
            ),
            { evidenceRetrieverOutput: evidenceOutput([colorectalSnippet]) },
        );
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('rejects a guideline claim when the retriever returned an empty snippet list this turn', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'reminder',
                    text: 'USPSTF recommends screening.',
                    sourceReferences: [
                        guidelineRef(
                            'uspstf::any-chunk',
                            'recommendation-summary',
                            'screening',
                        ),
                    ],
                }),
            ),
            { evidenceRetrieverOutput: evidenceOutput([]) },
        );
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('rejects a guideline claim when no retriever output is in scope (retriever did not run this turn)', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'reminder',
                    text: 'USPSTF says.',
                    sourceReferences: [
                        guidelineRef(
                            'uspstf::any-chunk',
                            'recommendation-summary',
                            'something',
                        ),
                    ],
                }),
            ),
            // intentionally no evidenceRetrieverOutput
        );
        expect(out.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});

// §C.5: confidence hard-stops applied AFTER source-reference
// resolution, BEFORE category fail-closed checks (architecture order).
// Default: drop the low-confidence claim with a typed reason. Allergy
// exception: a low-confidence allergy fact in an *intake form* fails
// the entire medication section closed (matches the W1 missing-allergy
// hard stop, applied symmetrically across chart-side and document-side
// gaps).
describe('verifyLedger — confidence hard-stops (§C.5)', () => {
    const lowConfSignal = {
        self_reported: 0.5,
        schema_warning_count: 0,
        patient_match: 'full',
    };
    const highConfSignal = {
        self_reported: 0.95,
        schema_warning_count: 0,
        patient_match: 'full',
    };

    const labSnippet: ExtractedFactSnippet = {
        artifactId: 'art-lab-low',
        documentUuid: 'doc-uuid-lab',
        docType: 'lab_pdf',
        fieldPath: 'results.0.value',
        value: '9.4',
        page: 1,
        bbox: [10, 20, 200, 40],
        quote: 'A1c 9.4 %',
        extractorVersion: 'v1',
        createdAt: '2026-04-15T10:00:00Z',
    };
    const allergySnippet: ExtractedFactSnippet = {
        artifactId: 'art-intake-allergy',
        documentUuid: 'doc-uuid-intake',
        docType: 'intake_form',
        fieldPath: 'allergies.0.substance',
        value: 'Penicillin',
        page: 2,
        bbox: [50, 100, 200, 30],
        quote: 'Penicillin',
        extractorVersion: 'v1',
        createdAt: '2026-04-15T10:00:00Z',
    };

    const extractedRef = (
        sourceId: string,
        snippet: ExtractedFactSnippet,
        quote: string,
    ) => ({
        source_type: 'extracted_document' as const,
        source_id: sourceId,
        locator: {
            page: snippet.page,
            bbox: snippet.bbox as [number, number, number, number],
            field: snippet.fieldPath,
        },
        quote,
    });

    it('accepts a high-confidence extracted_document claim (carry-forward)', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'Recent intake A1c 9.4',
                    sourceReferences: [extractedRef('art-lab-low', labSnippet, 'A1c 9.4')],
                }),
            ),
            {
                documentEvidenceSnippets: [labSnippet],
                artifactConfidence: new Map([['art-lab-low', highConfSignal]]),
            },
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('drops a low-confidence non-allergy extracted_document claim with reason low-confidence-extraction', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'Recent intake A1c 9.4',
                    sourceReferences: [extractedRef('art-lab-low', labSnippet, 'A1c 9.4')],
                }),
            ),
            {
                documentEvidenceSnippets: [labSnippet],
                artifactConfidence: new Map([['art-lab-low', lowConfSignal]]),
            },
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('low-confidence-extraction');
    });

    it('low-confidence allergy on an intake form fails the entire medication section closed', () => {
        // Architecture allergy exception: the *category* fail-closes,
        // not just the one fact. We assert by feeding both an allergy
        // claim and a prescription claim — both should drop, and the
        // hard-stop list reports `allergies-unavailable` (same shape
        // as W1's missing-chart-allergies stop, surfaced symmetrically
        // for the document-side gap).
        const out = verifyLedger(
            baseSnapshot(),
            {
                claims: [
                    claim({
                        id: 'allergy-low',
                        category: 'allergy',
                        text: 'Patient reports Penicillin allergy.',
                        sourceReferences: [
                            extractedRef('art-intake-allergy', allergySnippet, 'Penicillin'),
                        ],
                        safetyCritical: true,
                    }),
                    claim({
                        id: 'rx-collateral',
                        category: 'prescription',
                        text: 'Metformin 500 mg BID',
                        sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                        safetyCritical: true,
                    }),
                ],
            },
            {
                documentEvidenceSnippets: [allergySnippet],
                artifactConfidence: new Map([['art-intake-allergy', lowConfSignal]]),
            },
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected.map((r) => r.reason).sort()).toEqual([
            'low-confidence-extraction',
            'safety-critical-data-unavailable',
        ]);
        expect(out.safetyHardStops).toContain('allergies-unavailable');
        expect(out.passed).toBe(false);
    });

    it('high-confidence allergy on an intake form does NOT fire the category fail-closed', () => {
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'allergy',
                    text: 'Patient reports Penicillin allergy.',
                    sourceReferences: [
                        extractedRef('art-intake-allergy', allergySnippet, 'Penicillin'),
                    ],
                    safetyCritical: true,
                }),
            ),
            {
                documentEvidenceSnippets: [allergySnippet],
                artifactConfidence: new Map([['art-intake-allergy', highConfSignal]]),
            },
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.safetyHardStops).not.toContain('allergies-unavailable');
    });

    it('low-confidence allergy on a *lab_pdf* does NOT fail closed (intake-form-specific)', () => {
        // The architecture pins the allergy exception to intake forms
        // explicitly. A low-confidence allergy field landed on a lab
        // PDF would be an extractor bug, not a clinically meaningful
        // allergy claim — the broad fail-closed wouldn't help.
        const labWithAllergyShape: ExtractedFactSnippet = {
            ...labSnippet,
            fieldPath: 'allergies.0.substance',
            quote: 'Penicillin',
            value: 'Penicillin',
        };
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'allergy',
                    text: 'Penicillin allergy noted.',
                    sourceReferences: [
                        extractedRef('art-lab-low', labWithAllergyShape, 'Penicillin'),
                    ],
                    safetyCritical: true,
                }),
            ),
            {
                documentEvidenceSnippets: [labWithAllergyShape],
                artifactConfidence: new Map([['art-lab-low', lowConfSignal]]),
            },
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('low-confidence-extraction');
        expect(out.safetyHardStops).not.toContain('allergies-unavailable');
    });

    it('treats a missing artifactConfidence entry as low-confidence (fail-closed default)', () => {
        // Production wiring populates the map for every artifact the
        // retriever returned. If a future bug omits one, the verifier
        // must not treat absence as "high confidence".
        const out = verifyLedger(
            baseSnapshot(),
            single(
                claim({
                    category: 'lab',
                    text: 'Recent intake A1c 9.4',
                    sourceReferences: [extractedRef('art-lab-low', labSnippet, 'A1c 9.4')],
                }),
            ),
            {
                documentEvidenceSnippets: [labSnippet],
                artifactConfidence: new Map(),
            },
        );
        expect(out.rejected[0]?.reason).toBe('low-confidence-extraction');
    });
});

describe('verifyLedger — tolerant content matcher (regression)', () => {
    // Production incident May 2026: the strict substring rule rejected
    // valid claims for trivial wording differences. The tolerant
    // matcher accepts plural-form drift and comma-swapped LOINC analyte
    // names while still rejecting omissions and substitutions.

    it('accepts an allergy claim that drops the trailing s (NSAID vs NSAIDs)', () => {
        const out = verifyLedger(
            baseSnapshot({
                allergies: [
                    {
                        substance: 'NSAIDs',
                        reaction: null,
                        severity: 'moderate',
                        source: sourceRef('AllergyIntolerance', 'a-nsaid'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'allergy',
                    text: 'NSAID allergy, moderate severity',
                    sourceReferences: [sourceRef('AllergyIntolerance', 'a-nsaid')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.passed).toBe(true);
    });

    it('accepts a lab claim where the LOINC analyte is comma-swapped', () => {
        const out = verifyLedger(
            baseSnapshot({
                labs: [
                    {
                        analyte: 'Glucose, Fasting',
                        value: '93',
                        unit: 'mg/dL',
                        referenceRange: null,
                        abnormalFlag: null,
                        observedAt: '2026-04-30',
                        source: sourceRef('Observation', 'lab-fbg'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'lab',
                    text: 'Fasting glucose 93 mg/dL on 2026-04-30 (normal)',
                    sourceReferences: [sourceRef('Observation', 'lab-fbg')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('still rejects an allergy claim that names the wrong substance entirely', () => {
        // The tolerant matcher must not become so loose that "Sulfa
        // allergy" matches an "NSAIDs" record. Tokens are required to
        // appear, not just any of them.
        const out = verifyLedger(
            baseSnapshot({
                allergies: [
                    {
                        substance: 'NSAIDs',
                        reaction: null,
                        severity: 'moderate',
                        source: sourceRef('AllergyIntolerance', 'a-nsaid'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'allergy',
                    text: 'Sulfa allergy on file',
                    sourceReferences: [sourceRef('AllergyIntolerance', 'a-nsaid')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('still rejects a lab claim that fabricates a value against a real analyte', () => {
        // The value branch stays strict — fabricated numbers are
        // exactly the failure mode the lab rule exists to catch.
        const out = verifyLedger(
            baseSnapshot({
                labs: [
                    {
                        analyte: 'Glucose, Fasting',
                        value: '93',
                        unit: 'mg/dL',
                        referenceRange: null,
                        abnormalFlag: null,
                        observedAt: '2026-04-30',
                        source: sourceRef('Observation', 'lab-fbg'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'lab',
                    text: 'Fasting glucose 250 mg/dL (severely elevated)',
                    sourceReferences: [sourceRef('Observation', 'lab-fbg')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('still rejects an NSAIDs-record claim that says "no allergies on file"', () => {
        // The "drop trailing s" rule must not flip a positive record
        // into a negation acceptable. The token bag would reduce
        // "NSAIDs" to {nsaid}, and "no allergies on file" doesn't
        // contain it, so the rejection still fires.
        const out = verifyLedger(
            baseSnapshot({
                allergies: [
                    {
                        substance: 'NSAIDs',
                        reaction: null,
                        severity: 'moderate',
                        source: sourceRef('AllergyIntolerance', 'a-nsaid'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'allergy',
                    text: 'No known drug allergies on file',
                    sourceReferences: [sourceRef('AllergyIntolerance', 'a-nsaid')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('accepts a diagnosis claim where the label is reordered', () => {
        const out = verifyLedger(
            baseSnapshot({
                diagnoses: [
                    {
                        code: 'I10',
                        codeSystem: 'ICD-10',
                        label: 'Hypertension, essential',
                        onsetDate: null,
                        source: sourceRef('Condition', 'c-htn'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'diagnosis',
                    text: 'Essential hypertension, controlled on lisinopril',
                    sourceReferences: [sourceRef('Condition', 'c-htn')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });
});

describe('verifyLedger — lab analyte aliases (regression)', () => {
    // Production incident May 2026: synthesizer claims using standard
    // medical abbreviations (HbA1c, BUN, "LDL cholesterol") were
    // rejected as unverified because the chart's `analyte` carried
    // the spelled-out LOINC display string ("Hemoglobin A1c", "Blood
    // Urea Nitrogen", "LDL Cholesterol (calculated)"). The token-bag
    // matcher demanded every chart token appear in the claim, so the
    // model's compact prose failed even when value/date/unit were
    // correct. Lab-analyte aliases now bridge the gap.

    const labFixture = (
        analyte: string,
        overrides: { value?: string; unit?: string | null; observedAt?: string | null } = {},
    ) => ({
        analyte,
        value: overrides.value ?? '8.1',
        unit: overrides.unit ?? '%',
        referenceRange: '4.0-5.6',
        abnormalFlag: 'high',
        observedAt: overrides.observedAt ?? '2026-04-06',
        source: sourceRef('Observation', 'lab-1'),
    });

    it('accepts HbA1c claim against a "Hemoglobin A1c" chart row', () => {
        const out = verifyLedger(
            baseSnapshot({ labs: [labFixture('Hemoglobin A1c')] }),
            single(
                claim({
                    category: 'lab',
                    text: 'HbA1c was 8.1% on 2026-04-06 (flagged high; reference range 4.0–5.6%).',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('accepts BUN claim against a "Blood Urea Nitrogen" chart row', () => {
        const out = verifyLedger(
            baseSnapshot({
                labs: [
                    labFixture('Blood Urea Nitrogen', {
                        value: '7',
                        unit: 'mg/dL',
                        observedAt: '2026-05-06',
                    }),
                ],
            }),
            single(
                claim({
                    category: 'lab',
                    text: 'BUN was 7 mg/dL on 2026-05-06, within the reference range of 7–20 mg/dL.',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('accepts "LDL cholesterol" claim against an "LDL Cholesterol (calculated)" chart row', () => {
        const out = verifyLedger(
            baseSnapshot({
                labs: [
                    labFixture('LDL Cholesterol (calculated)', {
                        value: '129',
                        unit: 'mg/dL',
                        observedAt: '2026-02-05',
                    }),
                ],
            }),
            single(
                claim({
                    category: 'lab',
                    text: 'LDL cholesterol 129 mg/dL on 2026-02-05 (flagged high)',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('still rejects an aliased analyte claim that fabricates the value', () => {
        // The alias relaxation is on the analyte name only — the
        // value branch must still gate fabrication.
        const out = verifyLedger(
            baseSnapshot({ labs: [labFixture('Hemoglobin A1c')] }),
            single(
                claim({
                    category: 'lab',
                    text: 'HbA1c was 12.0% — markedly elevated.',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('still rejects an aliased analyte claim that mentions the wrong date', () => {
        const out = verifyLedger(
            baseSnapshot({ labs: [labFixture('Hemoglobin A1c')] }),
            single(
                claim({
                    category: 'lab',
                    text: 'HbA1c was 8.1% on 2025-04-06 (a year earlier than the row).',
                    sourceReferences: [sourceRef('Observation', 'lab-1')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });
});

describe('verifyLedger — prescription form/route descriptors (regression)', () => {
    // Same May 2026 incident: chart drug names follow the RxNorm
    // pattern "<name> <strength> <route> <form>" ("Metformin
    // hydrochloride 500 MG Oral Tablet"). Synthesizers re-render
    // these as natural prose ("Metformin hydrochloride 500 mg twice
    // daily") and omit the route/form descriptors — those tokens are
    // not load-bearing for safety. The drug name + strength remain
    // load-bearing and stay enforced.

    it('accepts a prescription claim that omits the "Oral Tablet" route+form', () => {
        const out = verifyLedger(
            baseSnapshot({
                prescriptions: [
                    {
                        name: 'Metformin hydrochloride 500 MG Oral Tablet',
                        dose: '500 mg',
                        route: 'oral',
                        frequency: 'twice daily',
                        startDate: '2026-03-11',
                        stopDate: null,
                        prescriber: null,
                        indication: 'Type 2 diabetes mellitus',
                        prescriptionId: 'rx-met',
                        source: sourceRef('MedicationRequest', 'rx-met'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'prescription',
                    text: 'Metformin hydrochloride 500 mg twice daily, started 2026-03-11.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-met')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('accepts a prescription claim that uses an XR/ER suffix omission', () => {
        const out = verifyLedger(
            baseSnapshot({
                prescriptions: [
                    {
                        name: 'Metoprolol succinate ER 50 MG Oral Tablet',
                        dose: '50 mg',
                        route: 'oral',
                        frequency: 'once daily',
                        startDate: '2026-01-15',
                        stopDate: null,
                        prescriber: null,
                        indication: 'Hypertension',
                        prescriptionId: 'rx-meto',
                        source: sourceRef('MedicationRequest', 'rx-meto'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'prescription',
                    text: 'Metoprolol succinate 50 mg once daily.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-meto')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(1);
    });

    it('still rejects a prescription claim that names a different drug', () => {
        // The descriptor stripping must not loosen the drug-name
        // requirement. Lisinopril vs Metformin still rejects.
        const out = verifyLedger(
            baseSnapshot({
                prescriptions: [
                    {
                        name: 'Metformin hydrochloride 500 MG Oral Tablet',
                        dose: '500 mg',
                        route: 'oral',
                        frequency: 'twice daily',
                        startDate: '2026-03-11',
                        stopDate: null,
                        prescriber: null,
                        indication: 'Type 2 diabetes mellitus',
                        prescriptionId: 'rx-met',
                        source: sourceRef('MedicationRequest', 'rx-met'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'prescription',
                    text: 'Lisinopril 10 mg once daily.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-met')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('still rejects a prescription claim that drops the strength', () => {
        // Strength is load-bearing — a 500 mg vs 1000 mg confusion is
        // a real safety risk. The matcher must keep strength tokens.
        const out = verifyLedger(
            baseSnapshot({
                prescriptions: [
                    {
                        name: 'Metformin hydrochloride 500 MG Oral Tablet',
                        dose: '500 mg',
                        route: 'oral',
                        frequency: 'twice daily',
                        startDate: '2026-03-11',
                        stopDate: null,
                        prescriber: null,
                        indication: 'Type 2 diabetes mellitus',
                        prescriptionId: 'rx-met',
                        source: sourceRef('MedicationRequest', 'rx-met'),
                    },
                ],
            }),
            single(
                claim({
                    category: 'prescription',
                    text: 'Metformin hydrochloride twice daily.',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-met')],
                }),
            ),
        );
        expect(out.accepted).toHaveLength(0);
        expect(out.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });
});
