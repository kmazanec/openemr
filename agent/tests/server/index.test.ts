import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../../src/server/index.js';
import type { BriefingRunner } from '../../src/server/briefingRunner.js';
import type { BriefingStreamEvent } from '../../src/server/briefingStream.js';
import { mintTestToken } from '../auth/testKeys.js';
import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

describe('agent server', () => {
    let originalDatabaseUrl: string | undefined;
    let originalBaseUrl: string | undefined;

    beforeEach(() => {
        originalDatabaseUrl = process.env['DATABASE_URL'];
        originalBaseUrl = process.env['OPENEMR_BASE_URL'];
    });

    afterEach(() => {
        if (originalDatabaseUrl === undefined) {
            delete process.env['DATABASE_URL'];
        } else {
            process.env['DATABASE_URL'] = originalDatabaseUrl;
        }
        if (originalBaseUrl === undefined) {
            delete process.env['OPENEMR_BASE_URL'];
        } else {
            process.env['OPENEMR_BASE_URL'] = originalBaseUrl;
        }
    });

    it('start() rejects when DATABASE_URL is unset', async () => {
        delete process.env['DATABASE_URL'];
        await expect(start(0)).rejects.toThrow(/DATABASE_URL/);
    });

    it('start() rejects when OPENEMR_BASE_URL is unset', async () => {
        process.env['DATABASE_URL'] = 'postgres://stub';
        delete process.env['OPENEMR_BASE_URL'];
        await expect(start(0)).rejects.toThrow(/OPENEMR_BASE_URL/);
    });

    it('GET /health returns ok without authentication', async () => {
        const { app } = await buildAuthedApp();
        const res = await app.request('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('POST /v1/agent/respond rejects requests without a bearer token', async () => {
        const { app } = await buildAuthedApp();
        const res = await app.request('/v1/agent/respond', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'hi' }),
        });
        expect(res.status).toBe(401);
    });

    it('POST /v1/agent/respond echoes the body and the authenticated fhirUser', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const body = { conversationId: 'conv-1', message: 'hello' };
        const res = await app.request('/v1/agent/respond', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            received: body,
            fhirUser: 'Practitioner/dr-patel',
        });
    });

});

describe('POST /v1/agent/briefing', () => {
    const briefingBody = {
        conversationId: 'conv-1',
        requestId: 'req-1',
        siteId: 'default',
        patient: { pid: 42, uuid: 'p-uuid' },
        task: 'default_briefing',
    };

    it('rejects requests without a bearer token', async () => {
        const { app } = await buildAuthedApp();
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(briefingBody),
        });
        expect(res.status).toBe(401);
    });

    it('emits an invalid_envelope error event on a malformed body', async () => {
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
            body: JSON.stringify({ patient: { pid: 'not-a-number' } }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"invalid_envelope"');
    });

    it('forwards the bearer token and authenticated fhirUser to the runner', async () => {
        const seen: { token: string | null; fhirUser: string | null } = {
            token: null,
            fhirUser: null,
        };
        const runner: BriefingRunner = ({ envelope, token }) => {
            seen.token = token;
            seen.fhirUser = envelope.actor.fhirUser;
            return Promise.resolve([]);
        };
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
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
            body: JSON.stringify(briefingBody),
        });
        expect(res.status).toBe(200);
        await res.text();
        expect(seen.token).toBe(token);
        expect(seen.fhirUser).toBe('Practitioner/dr-patel');
    });

    it('streams every event the runner produces, in order', async () => {
        const events: readonly BriefingStreamEvent[] = [
            { type: 'meta', conversationId: 'conv-1', requestId: 'req-1', siteId: 'default' },
            {
                type: 'assistantMessage',
                message: {
                    segments: [
                        {
                            text: 'Patel, Maya is here for a follow-up.',
                            claims: [
                                {
                                    id: 'id-1',
                                    text: 'Patient demographics',
                                    category: 'identity',
                                    sourceReferences: [
                                        {
                                            source_type: 'chart' as const,
                                            source_id: '42',
                                            locator: { field: 'patient.name' },
                                            quote: '42',
                                        },
                                    ],
                                    safetyCritical: false,
                                },
                            ],
                            redacted: false,
                        },
                    ],
                    claimGroups: {},
                    gaps: [],
                    suggestedFollowUps: [],
                    archetypeFlags: [],
                },
            },
            { type: 'done', persistedAt: '2026-04-30T12:00:00.000Z' },
        ];
        const runner: BriefingRunner = () => Promise.resolve(events);
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
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
            body: JSON.stringify(briefingBody),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const text = await res.text();
        const eventLines = text.split('\n').filter((l) => l.startsWith('event: '));
        expect(eventLines).toEqual(['event: meta', 'event: assistantMessage', 'event: done']);
    });

    it('flushes progress events live through onEvent so the panel paints stage spinners during the run', async () => {
        // Mock runner mimics the production runner's onEvent path: it
        // pushes meta + a couple of progress events + the terminal pair
        // through the callback, then returns an empty buffer (the
        // route iterates that buffer for legacy mocks; the real runner
        // also returns [] when onEvent is set, so the wire output is
        // exactly what onEvent received). This pins the SSE wire
        // contract used by panel.js — the renderer reads `event:
        // progress` lines off the same stream as the existing event
        // types.
        const runner: BriefingRunner = async ({ envelope, onEvent }) => {
            if (onEvent === undefined) return [];
            await onEvent({
                type: 'meta',
                conversationId: envelope.conversationId,
                requestId: envelope.requestId,
                siteId: envelope.siteId,
            });
            await onEvent({
                type: 'progress',
                stage: 'retrieve',
                label: 'Reading the chart',
                status: 'started',
            });
            await onEvent({
                type: 'progress',
                stage: 'retrieve',
                label: 'Reading the chart',
                status: 'completed',
            });
            await onEvent({
                type: 'assistantMessage',
                message: { segments: [], claimGroups: {}, gaps: [], suggestedFollowUps: [], archetypeFlags: [] },
            });
            await onEvent({ type: 'done', persistedAt: '2026-04-30T12:00:00.000Z' });
            return [];
        };
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
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
            body: JSON.stringify(briefingBody),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        const eventLines = text.split('\n').filter((l) => l.startsWith('event: '));
        // `progress` lines appear between `meta` and `assistantMessage` —
        // panel.js depends on this ordering to flip its stage UI before
        // the real bubble lands.
        expect(eventLines).toEqual([
            'event: meta',
            'event: progress',
            'event: progress',
            'event: assistantMessage',
            'event: done',
        ]);
        expect(text).toContain('"stage":"retrieve"');
        expect(text).toContain('"label":"Reading the chart"');
    });

    it('forwards the follow-up task and question into the envelope (§4.5)', async () => {
        const seen: { task: string | null; question: string | undefined } = {
            task: null,
            question: undefined,
        };
        const runner: BriefingRunner = ({ envelope }) => {
            seen.task = envelope.task;
            seen.question = envelope.question;
            return Promise.resolve([]);
        };
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
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
            body: JSON.stringify({
                ...briefingBody,
                task: 'follow_up',
                question: 'What was her last A1c?',
            }),
        });
        expect(res.status).toBe(200);
        await res.text();
        expect(seen.task).toBe('follow_up');
        expect(seen.question).toBe('What was her last A1c?');
    });

    it('rejects a follow-up envelope with an empty question string', async () => {
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
            body: JSON.stringify({
                ...briefingBody,
                task: 'follow_up',
                question: '',
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"invalid_envelope"');
    });

    it('§4.2 forwards a typed lab_trend followUp without bridging a question', async () => {
        // §4.2 contract: `lab_trend` follow-ups flow as a typed envelope
        // straight to the synthesizer's UC2 path. The §4.1 bridge that
        // turned the params into a sentence is intentionally skipped —
        // `question` stays undefined so the synthesizer's typed-followUp
        // branch wins and the verifier evaluates against the strict
        // UC2 prompt's claims.
        const seen: { task: string | null; question: string | undefined; followUp: unknown } = {
            task: null,
            question: undefined,
            followUp: undefined,
        };
        const runner: BriefingRunner = ({ envelope }) => {
            seen.task = envelope.task;
            seen.question = envelope.question;
            seen.followUp = envelope.followUp;
            return Promise.resolve([]);
        };
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
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
            body: JSON.stringify({
                ...briefingBody,
                task: 'follow_up',
                followUp: { type: 'lab_trend', analyte: 'A1c' },
            }),
        });
        expect(res.status).toBe(200);
        await res.text();
        expect(seen.task).toBe('follow_up');
        expect(seen.question).toBeUndefined();
        expect(seen.followUp).toEqual({ type: 'lab_trend', analyte: 'A1c' });
    });

    it('§4.1 rejects a request that carries both `question` and `followUp`', async () => {
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
            body: JSON.stringify({
                ...briefingBody,
                task: 'follow_up',
                question: 'What was her last A1c?',
                followUp: { type: 'lab_trend', analyte: 'A1c' },
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"invalid_envelope"');
    });

    it('§4.1 rejects a lab_trend followUp whose analyte contains a glob char', async () => {
        // Defense-in-depth against the LIKE-wildcard escape in the production
        // ObservationServiceDataSource. The PHP layer escapes `%` and `_`, but
        // a hostile or malformed analyte should never reach the database in
        // the first place.
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
            body: JSON.stringify({
                ...briefingBody,
                task: 'follow_up',
                followUp: { type: 'lab_trend', analyte: '%' },
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"invalid_envelope"');
    });

    it('§4.1 rejects a followUp with an unknown discriminator type', async () => {
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
            body: JSON.stringify({
                ...briefingBody,
                task: 'follow_up',
                followUp: { type: 'unknown_type', analyte: 'A1c' },
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"invalid_envelope"');
    });

    it('emits a typed error event when the runner throws (failure-state UI surface)', async () => {
        const runner: BriefingRunner = () => Promise.reject(new Error('boom'));
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
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
            body: JSON.stringify(briefingBody),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"briefing_failed"');
    });
});
