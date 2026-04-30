import { describe, expect, it } from 'vitest';

import { mintTestToken } from '../auth/testKeys.js';
import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

describe('POST /v1/agent/echo', () => {
    it('rejects unauthenticated requests', async () => {
        const { app } = await buildAuthedApp();
        const res = await app.request('/v1/agent/echo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(401);
    });

    it('streams the echo envelope back over SSE for an authenticated request', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
            scopes: [],
        });
        const body = { hello: 'world' };
        const res = await app.request('/v1/agent/echo', {
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
        const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
        expect(dataLine).toBeDefined();
        const payload = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
        expect(payload).toMatchObject({
            ok: true,
            action: 'echo',
            fhirUser: 'Practitioner/dr-patel',
            received: body,
        });
    });

    it('handles an empty request body without crashing', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            subject: 'Practitioner/dr-patel',
            scopes: [],
        });
        const res = await app.request('/v1/agent/echo', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
        expect(dataLine).toBeDefined();
        const payload = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
        expect(payload).toMatchObject({
            ok: true,
            action: 'echo',
            fhirUser: 'Practitioner/dr-patel',
        });
    });
});
