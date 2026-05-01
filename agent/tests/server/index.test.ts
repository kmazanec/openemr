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
                                            system: 'openemr',
                                            recordType: 'Patient',
                                            recordId: '42',
                                            field: null,
                                            recordedAt: null,
                                        },
                                    ],
                                    safetyCritical: false,
                                },
                            ],
                            redacted: false,
                        },
                    ],
                    gaps: [],
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
