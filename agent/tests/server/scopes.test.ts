import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createBearerAuthMiddleware, getPrincipal } from '../../src/auth/middleware.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';
import { generateTestKey, mintTestToken } from '../auth/testKeys.js';

const TEST_ISSUER = 'https://emr.test/oauth2/default';
const TEST_AUDIENCE = 'openemr-clinical-copilot-agent';

/**
 * F1: exercise the scopes round-trip end-to-end through the middleware
 * onto a route that reads `principal.scopes`. Phase 1 only ships `echo`
 * (empty scopes), so no production route exposes the path. Pinning it
 * here means Phase 3's `briefing` route can't accidentally regress the
 * shape — the test will already be green when the route is wired.
 */
describe('scopes claim round-trip', () => {
    it('preserves a non-empty scopes claim from token to handler', async () => {
        const { privateKey, publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
        });

        const app = new Hono();
        app.use('/v1/*', createBearerAuthMiddleware({ verify }));
        app.get('/v1/_test/scopes', (c) => {
            const principal = getPrincipal(c);
            return c.json({ scopes: principal.scopes });
        });

        const briefingScopes = [
            'openid',
            'fhirUser',
            'user/Patient.rs',
            'user/Condition.rs',
            'user/AllergyIntolerance.rs',
            'user/Observation.rs',
            'user/MedicationRequest.rs',
            'user/Encounter.rs',
            'user/Appointment.rs',
        ];
        const token = await mintTestToken(privateKey, {
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            scopes: briefingScopes,
        });

        const res = await app.request('/v1/_test/scopes', {
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { scopes: string[] };
        expect(body.scopes).toEqual(briefingScopes);
    });
});
