import { describe, expect, it, vi } from 'vitest';

import { createVerify } from '../../../src/graph/nodes/verify.js';
import type { BriefingSnapshot, Claim, RequestEnvelope } from '../../../src/graph/types.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import type {
    UnverifiedClaimRecord,
    UnverifiedClaimsLog,
} from '../../../src/verify/unverifiedClaimsLog.js';

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const envelope: RequestEnvelope = {
    conversationId: 'conv-1',
    requestId: 'req-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        source: sourceRef('Patient', '42'),
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
    labs: [],
    encounters: [],
    reminders: [],
    labHistory: null,
};

const goodClaim: Claim = {
    id: 'good',
    text: 'Active dx: E11.9 type 2 diabetes',
    category: 'diagnosis',
    sourceReferences: [sourceRef('Condition', 'c-1')],
    safetyCritical: false,
};

const orphanClaim: Claim = {
    id: 'orphan',
    text: 'Active dx: I10 hypertension',
    category: 'diagnosis',
    sourceReferences: [sourceRef('Condition', 'c-MISSING')],
    safetyCritical: false,
};

const buildLog = (): UnverifiedClaimsLog & {
    readonly recorded: UnverifiedClaimRecord[];
} => {
    const recorded: UnverifiedClaimRecord[] = [];
    return {
        recorded,
        setup: () => Promise.resolve(),
        record: (entries) => {
            recorded.push(...entries);
            return Promise.resolve();
        },
    };
};

describe('createVerify', () => {
    it('passes accepted claims through and reports passed=true on a clean ledger', async () => {
        const log = buildLog();
        const node = createVerify({ unverifiedClaimsLog: log });

        const out = await node({
            envelope,
            snapshot,
            draft: null,
            claimLedger: { claims: [goodClaim] },
            verified: null,
            formatted: null,
            persisted: null,
        });

        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toEqual([goodClaim]);
        expect(out.verified?.rejected).toHaveLength(0);
        expect(log.recorded).toHaveLength(0);
    });

    it('writes every dropped claim to the unverified-claims log with envelope context', async () => {
        const log = buildLog();
        const node = createVerify({ unverifiedClaimsLog: log });

        const out = await node({
            envelope,
            snapshot,
            draft: null,
            claimLedger: { claims: [goodClaim, orphanClaim] },
            verified: null,
            formatted: null,
            persisted: null,
        });

        expect(out.verified?.accepted.map((c) => c.id)).toEqual(['good']);
        expect(out.verified?.rejected.map((r) => r.claim.id)).toEqual(['orphan']);

        expect(log.recorded).toHaveLength(1);
        const entry = log.recorded[0];
        expect(entry?.claim.id).toBe('orphan');
        expect(entry?.reason).toBe('source-record-not-in-snapshot');
        expect(entry?.context.requestId).toBe('req-1');
        expect(entry?.context.conversationId).toBe('conv-1');
    });

    it('throws when called before Retrieve populated the snapshot', async () => {
        const log = buildLog();
        const node = createVerify({ unverifiedClaimsLog: log });
        await expect(
            node({
                envelope,
                snapshot: null,
                draft: null,
                claimLedger: { claims: [goodClaim] },
                verified: null,
                formatted: null,
                persisted: null,
            }),
        ).rejects.toThrow(/snapshot/i);
    });

    it('treats a missing claim ledger as an empty ledger', async () => {
        const log = buildLog();
        const node = createVerify({ unverifiedClaimsLog: log });

        const out = await node({
            envelope,
            snapshot,
            draft: null,
            claimLedger: null,
            verified: null,
            formatted: null,
            persisted: null,
        });

        expect(out.verified?.passed).toBe(true);
        expect(out.verified?.accepted).toHaveLength(0);
        expect(log.recorded).toHaveLength(0);
    });

    it('does not throw when the recorder fails — instrumentation must not block the response', async () => {
        const failingRecord = vi.fn(() => Promise.reject(new Error('db down')));
        const failingLog: UnverifiedClaimsLog = {
            setup: () => Promise.resolve(),
            record: failingRecord,
        };
        const node = createVerify({ unverifiedClaimsLog: failingLog });

        const out = await node({
            envelope,
            snapshot,
            draft: null,
            claimLedger: { claims: [orphanClaim] },
            verified: null,
            formatted: null,
            persisted: null,
        });

        expect(failingRecord).toHaveBeenCalledOnce();
        // The verified ledger still surfaces the rejection — only the
        // engineering write was lost.
        expect(out.verified?.rejected).toHaveLength(1);
        expect(out.verified?.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('records pass + claim counts on the counters sink when wired', async () => {
        const counters = createInMemoryCounters();
        const log = buildLog();
        const node = createVerify({ unverifiedClaimsLog: log, counters });

        await node({
            envelope,
            snapshot,
            draft: null,
            claimLedger: { claims: [goodClaim] },
            verified: null,
            formatted: null,
            persisted: null,
        });

        const snap = counters.snapshot();
        expect(snap.verification.passed).toBe(1);
        expect(snap.verification.failed).toBe(0);
        expect(snap.verification.acceptedClaims).toBe(1);
        expect(snap.verification.rejectedClaims).toBe(0);
        expect(snap.verification.promptInjections).toBe(0);
    });

    it('counts a fabricated source record reference as a prompt-injection failure', async () => {
        const counters = createInMemoryCounters();
        const log = buildLog();
        const node = createVerify({ unverifiedClaimsLog: log, counters });

        await node({
            envelope,
            snapshot,
            draft: null,
            claimLedger: { claims: [goodClaim, orphanClaim] },
            verified: null,
            formatted: null,
            persisted: null,
        });

        const snap = counters.snapshot();
        expect(snap.verification.failed).toBe(1);
        expect(snap.verification.acceptedClaims).toBe(1);
        expect(snap.verification.rejectedClaims).toBe(1);
        expect(snap.verification.promptInjections).toBe(1);
    });
});
