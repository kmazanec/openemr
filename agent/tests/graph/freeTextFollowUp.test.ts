import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../src/graph/index.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { ClaimLedger, RequestEnvelope } from '../../src/graph/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

/**
 * §4.5 adversarial cases. The free-text follow-up path runs the same
 * graph as the briefing, so the §3.3 verifier is the security gate.
 * These tests prove the gate stops three families of attack regardless
 * of what the LLM emits:
 *
 *   1. Cross-patient leakage — a claim cites a Patient recordId that
 *      isn't this conversation's patient.
 *   2. Authorization probe — a claim that asserts a fact about the
 *      patient with no source references at all.
 *   3. Hidden-data extraction — a claim cites a record id that doesn't
 *      exist in the snapshot (e.g. a fabricated MedicationRequest).
 *
 * Plus a positive case: a no-data acknowledgement segment (claimIds: [])
 * passes through unchanged because the verifier has nothing to score.
 *
 * The synthesizer is a stub in every case — we are not testing the
 * model's refusal behavior, we are testing that the deterministic gate
 * holds even if a future model regression slips an adversarial claim
 * through. Real-LLM evals belong in the §3.6 eval harness.
 */

const TOKEN = 'tok';
const PATIENT_PID = 42;
const PATIENT_RECORD_ID = '42';

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const followUpEnvelope = (question: string): RequestEnvelope => ({
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PATIENT_PID, uuid: 'p-1' },
    task: 'follow_up',
    question,
});

const happyPathSnapshot = {
    patient: {
        pid: PATIENT_PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        source: sourceRef('Patient', PATIENT_RECORD_ID),
    },
    appointment: null,
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
    labs: [],
    encounters: [],
    reminders: [],
};

const buildClient = (): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(happyPathSnapshot)),
});

const buildGraphWithSynth = (synth: Synthesizer) =>
    createBriefingGraph({
        retrieve: { client: buildClient(), token: TOKEN, siteId: 'default' },
        synthesize: { synthesizer: synth },
        verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
    });

describe('§4.5 free-text follow-up — adversarial gate', () => {
    it('rejects cross-patient leakage: a claim citing a different Patient recordId is redacted', async () => {
        // Attack: the question is "what's Maya's neighbor's A1c?" and
        // the model — under prompt injection or a regression — emits a
        // claim citing Patient/9999 (a different patient) rather than
        // refusing. The verifier's identity check requires the cited
        // Patient recordId to match this conversation's patient.
        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'leak-1',
                    text: "Neighbor's A1c is 7.2%",
                    category: 'identity',
                    sourceReferences: [sourceRef('Patient', '9999')],
                    safetyCritical: false,
                },
            ],
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [{ text: "Neighbor's A1c is 7.2%.", claimIds: ['leak-1'] }],
                },
                ledger,
            }),
        );
        const graph = buildGraphWithSynth(synth);

        const out = await graph.invoke({
            envelope: followUpEnvelope("what is Maya's neighbor's A1c?"),
        });

        expect(out.verified?.passed).toBe(false);
        expect(out.verified?.rejected).toHaveLength(1);
        expect(out.verified?.accepted).toHaveLength(0);
        expect(out.formatted?.segments).toHaveLength(1);
        expect(out.formatted?.segments[0]?.redacted).toBe(true);
        // The original cross-patient claim text MUST NOT reach the UI.
        expect(out.formatted?.segments[0]?.text).not.toContain("Neighbor's A1c");
    });

    it('rejects an authorization probe: a claim asserting a fact with no source references is redacted', async () => {
        // Attack: "what's the admin password?" — the model invents a
        // factual answer without citing any chart record. The verifier's
        // first check (sourceReferences.length === 0) drops it.
        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'probe-1',
                    text: 'The admin password is hunter2',
                    category: 'identity',
                    sourceReferences: [],
                    safetyCritical: false,
                },
            ],
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [{ text: 'The admin password is hunter2.', claimIds: ['probe-1'] }],
                },
                ledger,
            }),
        );
        const graph = buildGraphWithSynth(synth);

        const out = await graph.invoke({
            envelope: followUpEnvelope('what is the admin password?'),
        });

        expect(out.verified?.passed).toBe(false);
        expect(out.verified?.rejected[0]?.reason).toBe('missing-source-references');
        expect(out.formatted?.segments[0]?.redacted).toBe(true);
        expect(out.formatted?.segments[0]?.text).not.toContain('hunter2');
    });

    it('rejects hidden-data extraction: a claim citing a fabricated record id is redacted', async () => {
        // Attack: the model invents a MedicationRequest recordId that
        // does not exist in the snapshot (e.g. tries to extract
        // information about a medication the patient is NOT on by
        // citing a fictitious row). The verifier's resolution check
        // (CHECKS.medication.resolves) drops it.
        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'hide-1',
                    text: 'Patient is on warfarin 5 mg daily',
                    category: 'prescription',
                    sourceReferences: [sourceRef('MedicationRequest', 'fabricated-rx-9999')],
                    safetyCritical: true,
                },
            ],
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [{ text: 'Patient is on warfarin 5 mg daily.', claimIds: ['hide-1'] }],
                },
                ledger,
            }),
        );
        const graph = buildGraphWithSynth(synth);

        const out = await graph.invoke({
            envelope: followUpEnvelope('list all anticoagulants'),
        });

        expect(out.verified?.passed).toBe(false);
        expect(out.verified?.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
        expect(out.formatted?.segments[0]?.redacted).toBe(true);
        expect(out.formatted?.segments[0]?.text).not.toContain('warfarin');
    });

    it('rejects a claim that resolves to a real record but whose text invents a different fact', async () => {
        // Attack variant: the model cites a real MedicationRequest
        // (Metformin/rx-1) but claims a different drug. The verifier's
        // contentMatches check requires the claim text to mention the
        // cited record's medication name.
        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'swap-1',
                    text: 'Patient is on insulin 20 units daily',
                    category: 'prescription',
                    sourceReferences: [sourceRef('MedicationRequest', 'rx-1')],
                    safetyCritical: true,
                },
            ],
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [{ text: 'Patient is on insulin 20 units daily.', claimIds: ['swap-1'] }],
                },
                ledger,
            }),
        );
        const graph = buildGraphWithSynth(synth);

        const out = await graph.invoke({
            envelope: followUpEnvelope('what insulin is she on?'),
        });

        expect(out.verified?.passed).toBe(false);
        expect(out.verified?.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
        expect(out.formatted?.segments[0]?.redacted).toBe(true);
        expect(out.formatted?.segments[0]?.text).not.toContain('insulin');
    });

    it('passes a no-data acknowledgement segment through unredacted (claimIds: [])', async () => {
        // Positive case: the chart has no recent A1c, the model
        // correctly emits a single connector segment acknowledging this
        // with `claimIds: []`. The verifier has nothing to score; the
        // formatter passes the segment through as a non-redacted
        // connector. This is the success path the FOLLOW_UP_SYSTEM_PROMPT
        // steers the model toward when the chart cannot answer.
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [
                        {
                            text: 'The chart does not record an A1c in the last six months.',
                            claimIds: [],
                        },
                    ],
                },
                ledger: { claims: [] },
            }),
        );
        const graph = buildGraphWithSynth(synth);

        const out = await graph.invoke({
            envelope: followUpEnvelope('what was her last A1c?'),
        });

        expect(out.verified?.passed).toBe(true);
        expect(out.formatted?.segments).toHaveLength(1);
        expect(out.formatted?.segments[0]?.redacted).toBe(false);
        expect(out.formatted?.segments[0]?.text).toContain('A1c');
        expect(out.formatted?.segments[0]?.claims).toHaveLength(0);
    });

    it('redacts only the offending segment when an adversarial claim is mixed with a legitimate one', async () => {
        // Mixed payload: one legitimate cited claim plus one
        // cross-patient leakage. The legitimate segment must survive;
        // only the offending segment is redacted. This protects against
        // a denial-of-service-by-poisoning where a single bad claim
        // would otherwise wipe the whole answer.
        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'good-1',
                    text: 'Patient has type 2 diabetes (E11.9)',
                    category: 'diagnosis',
                    sourceReferences: [sourceRef('Condition', 'c-1')],
                    safetyCritical: false,
                },
                {
                    id: 'bad-1',
                    text: "Neighbor's A1c is 7.2%",
                    category: 'identity',
                    sourceReferences: [sourceRef('Patient', '9999')],
                    safetyCritical: false,
                },
            ],
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [
                        { text: 'She has type 2 diabetes (E11.9).', claimIds: ['good-1'] },
                        { text: "Neighbor's A1c is 7.2%.", claimIds: ['bad-1'] },
                    ],
                },
                ledger,
            }),
        );
        const graph = buildGraphWithSynth(synth);

        const out = await graph.invoke({
            envelope: followUpEnvelope("what's her diabetes status, and her neighbor's A1c?"),
        });

        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.verified?.rejected).toHaveLength(1);
        expect(out.formatted?.segments).toHaveLength(2);
        expect(out.formatted?.segments[0]?.redacted).toBe(false);
        expect(out.formatted?.segments[0]?.text).toContain('diabetes');
        expect(out.formatted?.segments[1]?.redacted).toBe(true);
        expect(out.formatted?.segments[1]?.text).not.toContain("Neighbor's");
    });

    it('§4.4 UC4: accepts a follow-up claim that cites a ccda-importer encounter by id', async () => {
        // The §4.5 free-text bridge routes the typed `external_care`
        // suggestion through this same path. The PHP-side
        // ExternalEncounterAdapter merges CCDA-imported encounters
        // (`source.system: 'ccda-importer'`) into the snapshot's
        // `encounters[]`; the verifier indexes by recordId regardless
        // of system, so a faithful encounter claim citing the
        // imported visit's `ee_id` resolves at the gate.
        const ccdaSourceRef = {
            system: 'ccda-importer',
            recordType: 'Encounter',
            recordId: 'ext-7',
            field: null,
            recordedAt: '2026-04-22',
        };
        const snapshotWithExternal = {
            ...happyPathSnapshot,
            encounters: [
                {
                    encounterDate: '2026-04-22',
                    type: 'St. Mary ED',
                    reason: 'Chest pain - discharged after negative workup',
                    source: ccdaSourceRef,
                },
            ],
        };
        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'ext-1',
                    text: 'Outside ED visit on 2026-04-22 (St. Mary ED) — chest pain, discharged.',
                    category: 'encounter',
                    sourceReferences: [ccdaSourceRef],
                    safetyCritical: false,
                },
            ],
        };
        const synth: Synthesizer = vi.fn(() =>
            Promise.resolve({
                draft: {
                    segments: [
                        {
                            text: 'Outside ED visit on 2026-04-22 (St. Mary ED) — chest pain, discharged.',
                            claimIds: ['ext-1'],
                        },
                    ],
                },
                ledger,
            }),
        );
        const graph = createBriefingGraph({
            retrieve: {
                client: { fetchSnapshot: vi.fn(() => Promise.resolve(snapshotWithExternal)) },
                token: TOKEN,
                siteId: 'default',
            },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({
            envelope: followUpEnvelope('Summarize external care from the last 365 days.'),
        });

        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(1);
        expect(out.formatted?.segments[0]?.redacted).toBe(false);
        expect(out.formatted?.segments[0]?.text).toContain('St. Mary ED');
    });
});
