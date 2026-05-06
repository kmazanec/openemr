import { describe, expect, it } from 'vitest';

import type { BriefingRunner } from '../../src/server/briefingRunner.js';
import type { BriefingStreamEvent } from '../../src/server/briefingStream.js';
import type {
    RecordOutcome,
    ScheduleBriefingRecord,
    ScheduleBriefingsLog,
} from '../../src/state/scheduleBriefings.js';

import { mintTestToken } from '../auth/testKeys.js';
import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

const baseEnvelope = {
    conversationId: 'conv-precompute-1',
    requestId: 'req-precompute-1',
    siteId: 'default',
    patient: { pid: 42, uuid: 'p-uuid' },
    task: 'default_briefing',
    precompute: true,
    practitionerUuid: '11111111-1111-1111-1111-111111111111',
    appointmentId: 'appt-77',
    force: false,
};

const finishedAssistantEvent: BriefingStreamEvent = {
    type: 'assistantMessage',
    message: {
        segments: [],
        gaps: [
            {
                kind: 'gap',
                reason: 'safety-critical-rejected',
                message: 'a critical claim could not be verified',
            },
        ],
        suggestedFollowUps: [],
        archetypeFlags: [],
    },
};

const flaggedAssistantEvent: BriefingStreamEvent = {
    type: 'assistantMessage',
    message: {
        segments: [],
        gaps: [
            {
                kind: 'gap',
                reason: 'safety-critical-rejected',
                message: 'a critical claim could not be verified',
            },
        ],
        suggestedFollowUps: [],
        // §5.5: archetype-derived chip from the snapshot. The route
        // concatenates this with `gaps[].reason` codes into the row's
        // `flags[]`, so the schedule view sees both families.
        archetypeFlags: ['archetype:diabetic_uncontrolled'],
    },
};

interface FakeLogState {
    readonly recorded: ScheduleBriefingRecord[];
    readonly forceFlags: boolean[];
    readonly existsCalls: { practitionerUuid: string; appointmentId: string; today: string }[];
}

const buildFakeLog = (
    behavior: { existsForToday: boolean; recordOutcome: RecordOutcome },
): { log: ScheduleBriefingsLog; state: FakeLogState } => {
    const state: FakeLogState = { recorded: [], forceFlags: [], existsCalls: [] };
    const log: ScheduleBriefingsLog = {
        existsForToday: (key, today) => {
            state.existsCalls.push({ ...key, today });
            return Promise.resolve(behavior.existsForToday);
        },
        record: (entry, options) => {
            state.recorded.push(entry);
            state.forceFlags.push(options.force);
            return Promise.resolve(behavior.recordOutcome);
        },
        listForPractitionerDay: () => Promise.resolve([]),
    };
    return { log, state };
};

describe('POST /v1/agent/briefing — precompute branch', () => {
    it('rejects when precompute=true but appointmentId is missing', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const body: Record<string, unknown> = { ...baseEnvelope };
        delete body['appointmentId'];
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"invalid_envelope"');
    });

    it('returns precompute_unavailable when scheduleBriefingsLog is not wired', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(baseEnvelope),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"code":"precompute_unavailable"');
    });

    it('short-circuits with skipped_idempotent without invoking the runner', async () => {
        let runnerCalls = 0;
        const runner: BriefingRunner = () => {
            runnerCalls += 1;
            return Promise.resolve([]);
        };
        const { log, state } = buildFakeLog({
            existsForToday: true,
            recordOutcome: { written: true, outcome: 'inserted' },
        });
        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            scheduleBriefingsLog: log,
        });
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(baseEnvelope),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"outcome":"skipped_idempotent"');
        expect(text).toContain('"appointmentId":"appt-77"');
        expect(runnerCalls).toBe(0);
        expect(state.recorded).toHaveLength(0);
        expect(state.existsCalls).toHaveLength(1);
    });

    it('runs the runner with precompute metadata and writes a row when not idempotent', async () => {
        let observedExtra: Record<string, unknown> | undefined;
        const runner: BriefingRunner = ({ extraMetadata }) => {
            observedExtra = extraMetadata;
            return Promise.resolve([
                {
                    type: 'meta',
                    conversationId: baseEnvelope.conversationId,
                    requestId: baseEnvelope.requestId,
                    siteId: baseEnvelope.siteId,
                },
                finishedAssistantEvent,
                { type: 'done', persistedAt: '2026-05-02T12:00:00.000Z' },
            ]);
        };
        const { log, state } = buildFakeLog({
            existsForToday: false,
            recordOutcome: { written: true, outcome: 'inserted' },
        });
        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            scheduleBriefingsLog: log,
        });
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(baseEnvelope),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"outcome":"inserted"');
        expect(observedExtra).toEqual({ precompute: true });
        expect(state.recorded).toHaveLength(1);
        expect(state.recorded[0]?.flags).toEqual(['safety-critical-rejected']);
        expect(state.recorded[0]?.key).toEqual({
            practitionerUuid: baseEnvelope.practitionerUuid,
            appointmentId: baseEnvelope.appointmentId,
        });
        expect(state.forceFlags[0]).toBe(false);
    });

    it('§5.5 merges archetypeFlags into the recorded flags[] alongside gap reasons', async () => {
        // Two flag families ride into `flags[]`: gap reasons from the
        // verifier and archetype labels from the snapshot. The route
        // concatenates them in [gaps, archetype] order so the schedule
        // view's chip ordering matches the assistant message's gap
        // banner ordering.
        const runner: BriefingRunner = () => Promise.resolve([
            flaggedAssistantEvent,
            { type: 'done', persistedAt: '2026-05-02T12:00:00.000Z' },
        ]);
        const { log, state } = buildFakeLog({
            existsForToday: false,
            recordOutcome: { written: true, outcome: 'inserted' },
        });
        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            scheduleBriefingsLog: log,
        });
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(baseEnvelope),
        });
        expect(res.status).toBe(200);
        expect(state.recorded).toHaveLength(1);
        expect(state.recorded[0]?.flags).toEqual([
            'safety-critical-rejected',
            'archetype:diabetic_uncontrolled',
        ]);
    });

    it('passes force=true through to record() and skips the existence check', async () => {
        const runner: BriefingRunner = () => Promise.resolve([
            finishedAssistantEvent,
            { type: 'done', persistedAt: '2026-05-02T12:00:00.000Z' },
        ]);
        const { log, state } = buildFakeLog({
            existsForToday: true,
            recordOutcome: { written: true, outcome: 'overwritten' },
        });
        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            scheduleBriefingsLog: log,
        });
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ ...baseEnvelope, force: true }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"outcome":"overwritten"');
        expect(state.existsCalls).toHaveLength(0);
        expect(state.forceFlags[0]).toBe(true);
    });

    it('emits briefing_failed when the runner produces no assistant message', async () => {
        const runner: BriefingRunner = () => Promise.resolve([
            { type: 'done', persistedAt: '2026-05-02T12:00:00.000Z' },
        ]);
        const { log, state } = buildFakeLog({
            existsForToday: false,
            recordOutcome: { written: true, outcome: 'inserted' },
        });
        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            scheduleBriefingsLog: log,
        });
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(baseEnvelope),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"code":"briefing_failed"');
        expect(state.recorded).toHaveLength(0);
    });
});
