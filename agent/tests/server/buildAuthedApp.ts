import { createApp } from '../../src/server/index.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';
import { generateTestKey } from '../auth/testKeys.js';
import type { Hono } from 'hono';
import type { KeyLike } from 'jose';

export const TEST_ISSUER = 'https://emr.test/oauth2/default';
export const TEST_AUDIENCE = 'openemr-clinical-copilot-agent';

export interface AuthedApp {
    app: Hono;
    privateKey: KeyLike;
}

export const buildAuthedApp = async (): Promise<AuthedApp> => {
    const { privateKey, publicJwk } = await generateTestKey();
    const verify = createAgentJwtVerifier({
        keyResolver: createLocalKeyResolver([publicJwk]),
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
    });
    return { app: createApp({ auth: { verify } }), privateKey };
};
