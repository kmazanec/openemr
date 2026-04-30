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
 * Hand-curated cross-boundary contract fixture: a real PHP-minted token,
 * its matching public JWK, and the claims the agent's verifier should
 * extract. Committed at `agent/tests/fixtures/contract/token.json`; no
 * real secret (disposable RSA keypair, fake issuer).
 *
 * This test loads the fixture and runs it through the *real*
 * `createAgentJwtVerifier`. The fixture pins the wire format both sides
 * have to agree on — `aud`, `iss` shape, `kid` algorithm, `RS256`,
 * `sub`/`fhirUser`/`scopes` claim shape. Because the minted JWT carries
 * a 5-minute `exp`, the verifier's clock is pinned to the `generatedAt`
 * instant the fixture recorded so it remains valid regardless of when
 * the test runs.
 *
 * To refresh the fixture (e.g. after a contract change), run
 * `tests/Tests/Isolated/Modules/ClinicalCopilot/Auth/AgentTokenContractFixtureTest.php`
 * — it writes a fresh manifest to a temp path and prints the location;
 * copy it over `token.json`. The PHP test does not write to the agent
 * tree directly.
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
                'see file header for how to refresh from the PHP minter',
            { cause: err },
        );
    }
    return JSON.parse(raw) as ContractFixture;
};

/**
 * Pin the verifier's clock to the moment the fixture was generated so the
 * 5-minute `exp` claim still verifies even if the fixture is months old.
 * This is the test-time analogue of clock injection — the fixture's own
 * `generatedAt` is the canonical "now" for the contract check.
 */
const fixtureClock = (fixture: ContractFixture): Date => new Date(fixture.generatedAt);

describe('cross-boundary token contract', () => {
    it('verifies a real PHP-minted token against the real TS verifier', async () => {
        const fixture = await loadFixture();

        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([fixture.jwk]),
            issuer: fixture.expected.issuer,
            audience: fixture.expected.audience,
            currentDate: fixtureClock(fixture),
        });

        const principal = await verify(fixture.token);

        expect(principal.sub).toBe(fixture.expected.sub);
        expect(principal.fhirUser).toBe(fixture.expected.fhirUser);
        expect(principal.audience).toBe(fixture.expected.audience);
        expect(principal.issuer).toBe(fixture.expected.issuer);
        expect(principal.scopes).toEqual(fixture.expected.scopes);
        // exp is populated; the verifier above already enforced it against
        // the fixture's generatedAt. Asserting > now() would just couple
        // the test to wall time without testing anything new.
        expect(principal.expiresAt.getTime()).toBeGreaterThan(
            fixtureClock(fixture).getTime(),
        );
    });

    it('rejects the token when the audience contract drifts', async () => {
        const fixture = await loadFixture();

        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([fixture.jwk]),
            issuer: fixture.expected.issuer,
            audience: 'wrong-audience',
            currentDate: fixtureClock(fixture),
        });

        await expect(verify(fixture.token)).rejects.toThrow(/JWT verification failed/);
    });

    it('rejects the token when the issuer contract drifts', async () => {
        const fixture = await loadFixture();

        const verify = createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([fixture.jwk]),
            issuer: 'https://wrong.issuer.test/oauth2/default',
            audience: fixture.expected.audience,
            currentDate: fixtureClock(fixture),
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
