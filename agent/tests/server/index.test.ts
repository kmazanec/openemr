import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, start } from '../../src/server/index.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';
import { generateTestKey, mintTestToken } from '../auth/testKeys.js';

const ISSUER = 'https://emr.test/oauth2/default';
const AUDIENCE = 'openemr-clinical-copilot-agent';

const buildAuthedApp = async () => {
    const { privateKey, publicJwk } = await generateTestKey();
    const verify = createAgentJwtVerifier({
        keyResolver: createLocalKeyResolver([publicJwk]),
        issuer: ISSUER,
        audience: AUDIENCE,
    });
    const app = createApp({ auth: { verify } });
    return { app, privateKey };
};

describe('agent server', () => {
    let originalDatabaseUrl: string | undefined;

    beforeEach(() => {
        originalDatabaseUrl = process.env['DATABASE_URL'];
    });

    afterEach(() => {
        if (originalDatabaseUrl === undefined) {
            delete process.env['DATABASE_URL'];
        } else {
            process.env['DATABASE_URL'] = originalDatabaseUrl;
        }
    });

    it('start() rejects when DATABASE_URL is unset', async () => {
        delete process.env['DATABASE_URL'];
        await expect(start(0)).rejects.toThrow(/DATABASE_URL/);
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
            issuer: ISSUER,
            audience: AUDIENCE,
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

    it('POST /v1/agent/respond/stream returns an SSE stream that echoes the body', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await mintTestToken(privateKey, {
            issuer: ISSUER,
            audience: AUDIENCE,
            subject: 'Practitioner/dr-patel',
        });
        const body = { conversationId: 'conv-1', message: 'hello' };
        const res = await app.request('/v1/agent/respond/stream', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const text = await res.text();
        expect(text).toContain('data: ');
        const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
        expect(dataLine).toBeDefined();
        const payload: unknown = JSON.parse(dataLine!.slice('data: '.length));
        expect(payload).toEqual({ received: body, fhirUser: 'Practitioner/dr-patel' });
    });
});
