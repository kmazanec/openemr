import { describe, expect, it } from 'vitest';

import {
    encodeStreamEvent,
    eventsForBriefing,
    type BriefingStreamEvent,
} from '../../src/server/briefingStream.js';
import type { AssistantMessage, Claim, PersistedRecord, RequestEnvelope } from '../../src/graph/types.js';
import type { SourceReference } from '../../src/snapshot/types.js';

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

const sourceRef = (recordType: string, recordId: string) => ({
    source_type: 'chart' as const,
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const envelope: RequestEnvelope = {
    conversationId: 'conv-1',
    requestId: 'req-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'Practitioner/u-1' },
    patient: { pid: 42, uuid: 'p-1' },
    task: 'default_briefing',
};

const dxClaim: Claim = {
    id: 'dx-1',
    text: 'Type 2 diabetes',
    category: 'diagnosis',
    sourceReferences: [sourceRef('Condition', 'c-1')],
    safetyCritical: false,
};

const buildMessage = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
    segments: [
        { text: 'She has type 2 diabetes (E11.9).', claims: [dxClaim], redacted: false },
    ],
    gaps: [],
    suggestedFollowUps: [],
    archetypeFlags: [],
    ...overrides,
});

const persisted: PersistedRecord = {
    conversationId: 'conv-1',
    requestId: 'req-1',
    persistedAt: '2026-04-30T12:00:00.000Z',
};

describe('eventsForBriefing', () => {
    it('emits meta first, one assistantMessage event, done last', () => {
        const events = eventsForBriefing(envelope, buildMessage(), persisted);
        expect(events.map((e) => e.type)).toEqual(['meta', 'assistantMessage', 'done']);
    });

    it('preserves Claim + SourceReference structure on the assistant message (citation tag intact)', () => {
        const events = eventsForBriefing(envelope, buildMessage(), persisted);
        const msgEvent = events.find(
            (e): e is Extract<BriefingStreamEvent, { type: 'assistantMessage' }> =>
                e.type === 'assistantMessage',
        );
        expect(msgEvent).toBeDefined();
        const segment = msgEvent!.message.segments[0];
        expect(segment?.claims[0]?.sourceReferences[0]).toEqual(sourceRef('Condition', 'c-1'));
    });

    it('passes message-level gaps through unchanged so the UI can render the failure-state banner', () => {
        const message = buildMessage({
            gaps: [
                {
                    kind: 'gap',
                    reason: 'allergies-unavailable',
                    message: 'Allergy data is unavailable; prescription summary withheld.',
                },
            ],
        });
        const events = eventsForBriefing(envelope, message, persisted);
        const msgEvent = events.find(
            (e): e is Extract<BriefingStreamEvent, { type: 'assistantMessage' }> =>
                e.type === 'assistantMessage',
        );
        expect(msgEvent?.message.gaps).toEqual([
            {
                kind: 'gap',
                reason: 'allergies-unavailable',
                message: 'Allergy data is unavailable; prescription summary withheld.',
            },
        ]);
    });

    it('preserves redacted segments verbatim — the agent never ships the original text', () => {
        const message = buildMessage({
            segments: [
                { text: '[content withheld — could not be verified]', claims: [], redacted: true },
            ],
        });
        const events = eventsForBriefing(envelope, message, persisted);
        const msgEvent = events.find(
            (e): e is Extract<BriefingStreamEvent, { type: 'assistantMessage' }> =>
                e.type === 'assistantMessage',
        );
        expect(msgEvent?.message.segments[0]?.redacted).toBe(true);
        expect(msgEvent?.message.segments[0]?.claims).toEqual([]);
    });

    it('meta event carries envelope identifiers from the request envelope', () => {
        const events = eventsForBriefing(envelope, buildMessage(), persisted);
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

    it('encodes progress event with stage, label and status payload', () => {
        const out = encodeStreamEvent({
            type: 'progress',
            stage: 'retrieve',
            label: 'Reading the chart',
            status: 'started',
        });
        expect(out).toBe(
            'event: progress\ndata: {"type":"progress","stage":"retrieve","label":"Reading the chart","status":"started"}\n\n',
        );
    });
});
