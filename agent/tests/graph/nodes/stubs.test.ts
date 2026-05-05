import { describe, expect, it } from 'vitest';

import {
    documentEvidenceRetrieverStub,
    evidenceRetrieverStub,
    kickoffExtractionStub,
} from '../../../src/graph/nodes/stubs.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type { BriefingSnapshot, RequestEnvelope } from '../../../src/graph/types.js';

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const sourceRef = (id: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field },
    quote: id,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: sourceRef('42', 'patient.name'),
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

const state: BriefingState = {
    envelope,
    priorTurnContext: { turns: [] },
    snapshot,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 1,
    retrieveChartArgs: null,
    supervisorIterations: 1,
    supervisorDecisionHistory: [],
    capHit: false,
};

describe('phase-A retriever stubs (§A.7)', () => {
    it('kickoffExtractionStub returns an empty update', async () => {
        const out = await kickoffExtractionStub(state);
        expect(out).toEqual({});
    });

    it('documentEvidenceRetrieverStub returns an empty update', async () => {
        const out = await documentEvidenceRetrieverStub(state);
        expect(out).toEqual({});
    });

    it('evidenceRetrieverStub returns an empty update', async () => {
        const out = await evidenceRetrieverStub(state);
        expect(out).toEqual({});
    });
});
