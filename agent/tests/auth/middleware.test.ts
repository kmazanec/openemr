import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createBearerAuthMiddleware, getPrincipal } from '../../src/auth/middleware.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';
import { generateTestKey, mintTestToken } from './testKeys.js';

const ISSUER = 'https://emr.test/oauth2/default';
const AUDIENCE = 'openemr-clinical-copilot-agent';

const buildApp = async () => {
    const { privateKey, publicJwk } = await generateTestKey();
    const verify = createAgentJwtVerifier({
        keyResolver: createLocalKeyResolver([publicJwk]),
        issuer: ISSUER,
        audience: AUDIENCE,
    });
    const app = new Hono();
    app.use('/v1/*', createBearerAuthMiddleware({ verify }));
    app.get('/v1/whoami', (c) => {
        const principal = getPrincipal(c);
        return c.json({
            fhirUser: principal.fhirUser,
            scopes: principal.scopes,
            jti: principal.jti,
        });
    });
    app.get('/health', (c) => c.json({ status: 'ok' }));
    return { app, privateKey };
};

describe('bearer auth middleware', () => {
    it('rejects a request with no Authorization header (401)', async () => {
        const { app } = await buildApp();
        const res = await app.request('/v1/whoami');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects a request with a non-Bearer Authorization header (401)', async () => {
        const { app } = await buildApp();
        const res = await app.request('/v1/whoami', {
            headers: { authorization: 'Basic Zm9vOmJhcg==' },
        });
        expect(res.status).toBe(401);
    });

    it('rejects a request with an invalid bearer token (401)', async () => {
        const { app } = await buildApp();
        const res = await app.request('/v1/whoami', {
            headers: { authorization: 'Bearer not.a.token' },
        });
        expect(res.status).toBe(401);
    });

    it('accepts a valid bearer token and exposes the principal to handlers', async () => {
        const { app, privateKey } = await buildApp();
        const token = await mintTestToken(privateKey, {
            issuer: ISSUER,
            audience: AUDIENCE,
            subject: 'Practitioner/dr-patel',
            scopes: ['openid', 'fhirUser', 'patient/Patient.read'],
            jti: 'jti-mw-1',
        });

        const res = await app.request('/v1/whoami', {
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            fhirUser: 'Practitioner/dr-patel',
            scopes: ['openid', 'fhirUser', 'patient/Patient.read'],
            jti: 'jti-mw-1',
        });
    });

    it('does not gate routes outside the middleware path (e.g. /health)', async () => {
        const { app } = await buildApp();
        const res = await app.request('/health');
        expect(res.status).toBe(200);
    });
});
