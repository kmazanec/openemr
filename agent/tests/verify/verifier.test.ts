import { describe, expect, it } from 'vitest';

import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    HARD_STOP_MEDICATIONS_UNAVAILABLE,
    verifyLedger,
} from '../../src/verify/verifier.js';
import type { BriefingSnapshot, Claim, ClaimLedger } from '../../src/graph/types.js';

const sourceRef = (recordType: string, recordId: string, system = 'openemr') => ({
    system,
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

// §4.3: medication_change requires the claim to surface the documented
// prescriber + indication (when those fields are non-null in the source
// row). The deterministic medChangeBranch builds these claims; the rule
// is the gate that prevents a model regression from fabricating either.
describe('verifyLedger — medication_change category (§4.3 UC3)', () => {
    const provSnapshot = (med: { prescriber: string | null; indication: string | null }) =>
        baseSnapshot({
            medications: [
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
                    category: 'medication_change',
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
                    category: 'medication_change',
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
                    category: 'medication_change',
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
                    category: 'medication_change',
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
                    category: 'medication_change',
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

    it('also suppresses medication_change claims when the safety stop fires', () => {
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
                    category: 'medication_change',
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
