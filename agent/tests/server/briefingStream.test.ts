import { describe, expect, it } from 'vitest';

import {
    encodeStreamEvent,
    eventsForBriefing,
    type BriefingStreamEvent,
} from '../../src/server/briefingStream.js';
import type { FormattedBriefing, PersistedRecord, RequestEnvelope } from '../../src/graph/types.js';
import type { SourceReference } from '../../src/snapshot/types.js';

const sourceRef = (recordType: string, recordId: string): SourceReference => ({
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
    actor: { userId: 'u-1', fhirUser: 'Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const buildFormatted = (overrides: Partial<FormattedBriefing> = {}): FormattedBriefing => ({
    appointment: { text: 'No appointment in scope', source: null },
    demographics: { text: 'Patel, Maya (DOB 1958-03-15) F', source: sourceRef('Patient', '42') },
    activeDiagnoses: [
        { text: 'E11.9 (ICD-10) — Type 2 diabetes', source: sourceRef('Condition', 'c-1') },
    ],
    currentMedications: [
        { text: 'Metformin 500 mg BID PO', source: sourceRef('MedicationRequest', 'rx-1') },
    ],
    allergies: [{ text: 'Penicillin (Hives)', source: sourceRef('AllergyIntolerance', 'a-1') }],
    recentLabs: [],
    recentEncounters: [],
    ...overrides,
});

const persisted: PersistedRecord = {
    conversationId: 'conv-1',
    requestId: 'req-1',
    persistedAt: '2026-04-30T12:00:00.000Z',
};

describe('eventsForBriefing', () => {
    it('emits meta first, one event per section, done last', () => {
        const events = eventsForBriefing(envelope, buildFormatted(), persisted);
        expect(events[0]?.type).toBe('meta');
        expect(events.at(-1)?.type).toBe('done');
        const sectionNames = events.filter((e) => e.type === 'section').map((e) => e.section);
        expect(sectionNames).toEqual([
            'appointment',
            'demographics',
            'activeDiagnoses',
            'currentMedications',
            'allergies',
            'recentLabs',
            'recentEncounters',
        ]);
    });

    it('preserves SourceReference structure on each section payload (citation tag intact)', () => {
        const events = eventsForBriefing(envelope, buildFormatted(), persisted);
        const dxEvent = events.find(
            (e): e is Extract<BriefingStreamEvent, { type: 'section' }> =>
                e.type === 'section' && e.section === 'activeDiagnoses',
        );
        expect(dxEvent).toBeDefined();
        expect(Array.isArray(dxEvent!.payload)).toBe(true);
        const list = dxEvent!.payload as readonly { source: SourceReference }[];
        expect(list[0]?.source).toEqual(sourceRef('Condition', 'c-1'));
    });

    it('passes through a Gap section unchanged so the UI can render the failure state', () => {
        const formatted = buildFormatted({
            currentMedications: {
                kind: 'gap',
                reason: 'allergies-unavailable',
                message: 'Allergy data is unavailable; medication summary withheld.',
            },
        });
        const events = eventsForBriefing(envelope, formatted, persisted);
        const meds = events.find(
            (e): e is Extract<BriefingStreamEvent, { type: 'section' }> =>
                e.type === 'section' && e.section === 'currentMedications',
        );
        expect(meds?.payload).toEqual({
            kind: 'gap',
            reason: 'allergies-unavailable',
            message: 'Allergy data is unavailable; medication summary withheld.',
        });
    });

    it('meta event carries envelope identifiers from the request envelope', () => {
        const events = eventsForBriefing(envelope, buildFormatted(), persisted);
        const meta = events[0];
        expect(meta).toEqual({
            type: 'meta',
            conversationId: 'conv-1',
            requestId: 'req-1',
            siteId: 'default',
        });
    });
});

describe('encodeStreamEvent', () => {
    it('encodes as SSE with both event: and data: lines', () => {
        const out = encodeStreamEvent({
            type: 'meta',
            conversationId: 'c1',
            requestId: 'r1',
            siteId: 'default',
        });
        expect(out).toBe(
            'event: meta\ndata: {"type":"meta","conversationId":"c1","requestId":"r1","siteId":"default"}\n\n',
        );
    });

    it('encodes error event so the proxy can forward it untouched', () => {
        const out = encodeStreamEvent({ type: 'error', code: 'briefing_failed' });
        expect(out).toBe('event: error\ndata: {"type":"error","code":"briefing_failed"}\n\n');
    });
});
