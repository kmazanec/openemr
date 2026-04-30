import { describe, expect, it } from 'vitest';

import {
    AgentJwtVerificationError,
    createAgentJwtVerifier,
    type AgentPrincipal,
} from '../../src/auth/verify.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { generateTestKey, mintTestToken } from './testKeys.js';

const ISSUER = 'https://emr.test/oauth2/default';
const AUDIENCE = 'openemr-clinical-copilot-agent';

describe('verifyAgentJwt', () => {
    it('verifies a valid token and returns the principal with fhirUser from sub', async () => {
        const { privateKey, publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });
        const token = await mintTestToken(privateKey, {
            issuer: ISSUER,
            audience: AUDIENCE,
            subject: 'Practitioner/abc-123',
            scopes: ['openid', 'fhirUser', 'patient/Patient.read'],
            jti: 'jti-happy',
        });

        const principal: AgentPrincipal = await verify(token);

        expect(principal.sub).toBe('Practitioner/abc-123');
        expect(principal.fhirUser).toBe('Practitioner/abc-123');
        expect(principal.scopes).toEqual(['openid', 'fhirUser', 'patient/Patient.read']);
        expect(principal.jti).toBe('jti-happy');
        expect(principal.expiresAt).toBeInstanceOf(Date);
    });

    it('rejects a token signed by an unknown key', async () => {
        const trusted = await generateTestKey('trusted-kid');
        const attacker = await generateTestKey('attacker-kid');
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([trusted.publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });
        const token = await mintTestToken(attacker.privateKey, {
            issuer: ISSUER,
            audience: AUDIENCE,
            kid: 'attacker-kid',
        });

        await expect(verify(token)).rejects.toBeInstanceOf(AgentJwtVerificationError);
    });

    it('rejects a token with the wrong audience', async () => {
        const { privateKey, publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });
        const token = await mintTestToken(privateKey, {
            issuer: ISSUER,
            audience: 'some-other-client',
        });

        await expect(verify(token)).rejects.toBeInstanceOf(AgentJwtVerificationError);
    });

    it('rejects a token with the wrong issuer', async () => {
        const { privateKey, publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });
        const token = await mintTestToken(privateKey, {
            issuer: 'https://elsewhere.test/oauth2/default',
            audience: AUDIENCE,
        });

        await expect(verify(token)).rejects.toBeInstanceOf(AgentJwtVerificationError);
    });

    it('rejects an expired token', async () => {
        const { privateKey, publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });
        const token = await mintTestToken(privateKey, {
            issuer: ISSUER,
            audience: AUDIENCE,
            expiresIn: '-2m',
        });

        await expect(verify(token)).rejects.toBeInstanceOf(AgentJwtVerificationError);
    });

    it('rejects a malformed token', async () => {
        const { publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });

        await expect(verify('not.a.token')).rejects.toBeInstanceOf(AgentJwtVerificationError);
    });

    it('rejects a token signed with HS256 (alg confusion defense)', async () => {
        const { publicJwk } = await generateTestKey();
        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([publicJwk]),
            issuer: ISSUER,
            audience: AUDIENCE,
        });
        // header alg=HS256 + payload, signature garbage; verifier must refuse on alg, not on signature.
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
            'base64url',
        );
        const payload = Buffer.from(
            JSON.stringify({
                iss: ISSUER,
                aud: AUDIENCE,
                sub: 'Practitioner/x',
                exp: Math.floor(Date.now() / 1000) + 60,
            }),
        ).toString('base64url');
        const token = `${header}.${payload}.AAAA`;

        await expect(verify(token)).rejects.toBeInstanceOf(AgentJwtVerificationError);
    });
});
