<?php

/**
 * In-process JWT mint for Agent service requests.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use DateInterval;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\Signer\Rsa\Sha256;

/**
 * Mints a short-lived RS256 JWT for the Agent service.
 *
 * PRESEARCH §18 commits to invoking OpenEMR's existing OAuth2 key material
 * "directly" — i.e. without a self-loopback HTTP call to /oauth2/{site}/token.
 * The full grant pipeline (CustomClientCredentialsGrant et al.) requires a
 * registered oauth_clients row and a PSR-7 token request, neither of which
 * is appropriate for an in-process internal hop. We use OpenEMR's same RSA
 * private key + passphrase, then build the token directly with `Lcobucci\JWT`
 * so we can attach the `fhirUser` SMART claim and a stable `kid` header that
 * the agent service can match against the JWKS.
 *
 * Token contract:
 *   - sub: bare `users.uuid` of the acting practitioner
 *   - fhirUser: `{baseUrl}/Practitioner/{uuid}` (SMART convention)
 *   - aud: agent client identifier (`openemr-clinical-copilot-agent`)
 *   - iss: OpenEMR site's oauth2 base URL
 *   - scopes: per-action SMART scope list resolved by PolicyGate
 *   - exp: 5 minutes after `iat`
 *   - jti: per-mint random hex
 *   - header.kid: SHA-256 of the public-key SPKI PEM (S1)
 *   - header.alg: RS256
 */
final readonly class AgentTokenMinter
{
    public const AGENT_CLIENT_ID = 'openemr-clinical-copilot-agent';

    private const TOKEN_TTL = 'PT5M';

    public function __construct(
        private AgentSigningKey $signingKey,
        private ClockInterface $clock = new SystemClock(),
        private JtiGenerator $jtiGenerator = new RandomJtiGenerator(),
    ) {
    }

    /**
     * Production factory — reads OpenEMR's OAuth2 keys via `OAuth2KeyConfig`.
     */
    public static function fromOpenEmr(): self
    {
        return new self(AgentSigningKey::fromOAuth2KeyConfig());
    }

    /**
     * @param list<string> $scopes SMART scope strings, already filtered by PolicyGate.
     *
     * @throws AgentTokenMintException
     */
    public function mint(
        ResolvedFhirUser $fhirUser,
        array $scopes,
        string $issuer,
    ): string {
        try {
            $kid = JwksKeyId::fromPublicKey($this->signingKey->publicKeyPem);

            $config = Configuration::forAsymmetricSigner(
                new Sha256(),
                InMemory::plainText(
                    $this->signingKey->privateKeyPem,
                    $this->signingKey->passphrase ?? '',
                ),
                InMemory::plainText('empty', 'empty'),
            );

            $now = $this->clock->now();
            $builder = $config->builder()
                ->withHeader('kid', $kid)
                ->permittedFor(self::AGENT_CLIENT_ID)
                ->issuedBy($issuer)
                ->relatedTo($fhirUser->uuid)
                ->identifiedBy($this->jtiGenerator->generate())
                ->issuedAt($now)
                ->canOnlyBeUsedAfter($now)
                ->expiresAt($now->add(new DateInterval(self::TOKEN_TTL)))
                ->withClaim('fhirUser', $fhirUser->fhirUserUri)
                ->withClaim('scopes', $scopes);

            return $builder
                ->getToken($config->signer(), $config->signingKey())
                ->toString();
        } catch (AgentTokenMintException $e) {
            throw $e;
        } catch (\Throwable $e) {
            throw new AgentTokenMintException('Failed to sign agent JWT', 0, $e);
        }
    }
}
