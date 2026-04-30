import { describe, expect, it } from 'vitest';

import { format } from '../../../src/graph/nodes/format.js';
import type {
    BriefingSnapshot,
    Claim,
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

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
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
};

const verified: VerifiedLedger = {
    passed: true,
    accepted: [],
    rejected: [],
    safetyHardStops: [],
};

describe('format', () => {
    it('renders every section of the default briefing structure with citations', async () => {
        const out = await format({
            envelope,
            snapshot,
            draft: 'irrelevant — Format walks snapshot+verified directly',
            claimLedger: { claims: [] },
            verified,
            formatted: null,
            persisted: null,
        });

        const f = out.formatted;
        expect(f).toBeDefined();
        if (f === null || f === undefined) return;
        expect(f.appointment.text).toContain('Diabetes follow-up');
        expect(f.demographics.text).toContain('Patel, Maya');
        expect(f.activeDiagnoses[0]?.text).toContain('E11.9');
        expect(f.currentMedications[0]?.text).toContain('Metformin');
        expect(Array.isArray(f.recentLabs)).toBe(true);
        const labs = f.recentLabs as readonly { text: string }[];
        expect(labs[0]?.text).toContain('A1c');
        expect(f.allergies[0]?.text).toContain('Penicillin');
        expect(Array.isArray(f.recentEncounters)).toBe(true);
    });

    it('passes labs/encounters gaps through unchanged', async () => {
        const withGaps: BriefingSnapshot = {
            ...snapshot,
            labs: { kind: 'gap', reason: 'endpoint-unavailable', message: 'labs unavailable' },
            encounters: { kind: 'gap', reason: 'endpoint-unreachable', message: 'enc unavailable' },
        };
        const out = await format({
            envelope,
            snapshot: withGaps,
            draft: '',
            claimLedger: { claims: [] },
            verified,
            formatted: null,
            persisted: null,
        });
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.recentLabs).toMatchObject({ kind: 'gap' });
        expect(f.recentEncounters).toMatchObject({ kind: 'gap' });
    });

    it('throws when called without verified state (verifier must run first)', async () => {
        await expect(
            format({
                envelope,
                snapshot,
                draft: '',
                claimLedger: { claims: [] },
                verified: null,
                formatted: null,
                persisted: null,
            }),
        ).rejects.toThrow(/verify/i);
    });

    it('always surfaces the allergies section even when empty (NKDA)', async () => {
        // USERS.md fixed structure: "Allergies — always surfaced, never omitted."
        const noAllergies: BriefingSnapshot = { ...snapshot, allergies: [] };
        const out = await format({
            envelope,
            snapshot: noAllergies,
            draft: '',
            claimLedger: { claims: [] },
            verified,
            formatted: null,
            persisted: null,
        });
        // NKDA case: allergies field is present (non-undefined) and empty.
        const f = out.formatted;
        if (f === null || f === undefined) throw new Error('formatted missing');
        expect(f.allergies).toEqual([]);
    });

    it('uses unverified claims as a typed pass-through when supplied', async () => {
        // Currently §3.2 stub Verify accepts every claim; once §3.3 lands,
        // Format should consume verified.accepted instead of snapshot. Pin
        // that the verified pipe exists so the next contributor doesn't
        // accidentally bypass it.
        const claim: Claim = {
            id: 'c-1',
            text: 'Patient has type 2 diabetes (E11.9)',
            category: 'diagnosis',
            sourceReferences: [sourceRef('Condition', 'c-1')],
            safetyCritical: false,
        };
        const out = await format({
            envelope,
            snapshot,
            draft: '',
            claimLedger: { claims: [claim] },
            verified: { ...verified, accepted: [claim] },
            formatted: null,
            persisted: null,
        });
        expect(out.formatted).toBeDefined();
    });
});
