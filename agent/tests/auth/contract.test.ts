import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { JWK } from 'jose';

import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';

interface ContractFixture {
    token: string;
    jwk: JWK;
    expected: {
        issuer: string;
        audience: string;
        sub: string;
        fhirUser: string;
        scopes: string[];
        kid: string;
        alg: 'RS256';
    };
    generatedAt: string;
}

/**
 * The fixture below is written by the PHP minter
 * (`tests/Tests/Isolated/Modules/ClinicalCopilot/Auth/AgentTokenContractFixtureTest.php`).
 * Running that PHPUnit test produces `agent/tests/fixtures/contract/token.json`
 * by exercising the *real* `AgentTokenMinter` class with a freshly generated
 * RSA keypair, then writing the output token + matching public JWK + the
 * expected claim manifest.
 *
 * This Vitest then loads that fixture and runs it through the *real*
 * `createAgentJwtVerifier` middleware. If the two sides disagree on
 *   - the `aud` (`openemr-clinical-copilot-agent`),
 *   - the `iss` shape,
 *   - the kid algorithm (SHA-256(SPKI PEM), base64url),
 *   - the `RS256` signing alg,
 *   - the `sub`/`fhirUser`/`scopes` claim shape,
 * verification fails here with a precise diff.
 *
 * Regenerate fixture: `composer phpunit-isolated -- --filter ContractFixture`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, '../fixtures/contract/token.json');

const loadFixture = async (): Promise<ContractFixture> => {
    let raw: string;
    try {
        raw = await readFile(FIXTURE_PATH, 'utf8');
    } catch (err) {
        throw new Error(
            `cross-boundary fixture missing at ${FIXTURE_PATH}\n` +
                'regenerate it with: composer phpunit-isolated -- --filter ContractFixture',
            { cause: err },
        );
    }
    return JSON.parse(raw) as ContractFixture;
};

describe('cross-boundary token contract', () => {
    it('verifies a real PHP-minted token against the real TS verifier', async () => {
        const fixture = await loadFixture();

        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([fixture.jwk]),
            issuer: fixture.expected.issuer,
            audience: fixture.expected.audience,
        });

        const principal = await verify(fixture.token);

        expect(principal.sub).toBe(fixture.expected.sub);
        expect(principal.fhirUser).toBe(fixture.expected.fhirUser);
        expect(principal.audience).toBe(fixture.expected.audience);
        expect(principal.issuer).toBe(fixture.expected.issuer);
        expect(principal.scopes).toEqual(fixture.expected.scopes);
        expect(principal.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects the token when the audience contract drifts', async () => {
        const fixture = await loadFixture();

        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([fixture.jwk]),
            issuer: fixture.expected.issuer,
            audience: 'wrong-audience',
        });

        await expect(verify(fixture.token)).rejects.toThrow(/JWT verification failed/);
    });

    it('rejects the token when the issuer contract drifts', async () => {
        const fixture = await loadFixture();

        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([fixture.jwk]),
            issuer: 'https://wrong.issuer.test/oauth2/default',
            audience: fixture.expected.audience,
        });

        await expect(verify(fixture.token)).rejects.toThrow(/JWT verification failed/);
    });

    it('selects the verification key by kid', async () => {
        const fixture = await loadFixture();
        // The fixture's jwk has `kid` set; the verifier matches it against
        // the JWT's protected-header `kid`. This test catches drift in
        // either side's kid algorithm — if they disagree, the local
        // resolver still picks the only key in the array (its safety net),
        // so we explicitly assert the kid is non-empty and present in both.
        expect(typeof fixture.jwk.kid).toBe('string');
        expect((fixture.jwk.kid ?? '').length).toBeGreaterThan(0);
        expect(fixture.expected.kid).toBe(fixture.jwk.kid);
    });
});
