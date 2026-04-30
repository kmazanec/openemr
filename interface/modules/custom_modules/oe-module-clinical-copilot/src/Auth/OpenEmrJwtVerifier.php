<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use Lcobucci\Clock\FrozenClock;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\Signer\Rsa\Sha256;
use Lcobucci\JWT\Token\Plain;
use Lcobucci\JWT\Validation\Constraint\IssuedBy;
use Lcobucci\JWT\Validation\Constraint\PermittedFor;
use Lcobucci\JWT\Validation\Constraint\SignedWith;
use Lcobucci\JWT\Validation\Constraint\StrictValidAt;

/**
 * Verifies JWTs minted by {@see AgentTokenMinter} when the agent calls
 * back to OpenEMR. Symmetrical to the TS-side `createAgentJwtVerifier`.
 *
 * Trust contract — every check below is a hard reject:
 *   - RS256 signature against OpenEMR's OAuth2 public key
 *   - `iss` matches the configured issuer (site oauth2 base URL)
 *   - `aud` matches `AgentTokenMinter::AGENT_CLIENT_ID`
 *   - `iat`/`nbf`/`exp` valid relative to the injected clock
 *   - `fhirUser`, `scopes`, `jti`, `sub` claims present and well-shaped
 *
 * Verification failures throw a single typed exception. The caller's job
 * is to translate that to an opaque 401 — the server never tells the
 * client which check failed.
 */
final readonly class OpenEmrJwtVerifier
{
    /**
     * @phpstan-var non-empty-string
     */
    private string $publicKeyPem;

    public function __construct(
        string $publicKeyPem,
        private string $issuer,
        private string $audience,
        private ClockInterface $clock = new SystemClock(),
    ) {
        if ($publicKeyPem === '') {
            throw new AgentTokenVerificationException('Public key PEM is empty');
        }
        $this->publicKeyPem = $publicKeyPem;
    }

    /**
     * Production factory — reads OpenEMR's OAuth2 public key (the same one
     * `AgentTokenMinter` signs with).
     */
    public static function fromOpenEmr(string $issuer): self
    {
        return new self(
            publicKeyPem: AgentSigningKey::fromOAuth2KeyConfig()->publicKeyPem,
            issuer: $issuer,
            audience: AgentTokenMinter::AGENT_CLIENT_ID,
        );
    }

    /**
     * @throws AgentTokenVerificationException
     */
    public function verify(string $rawToken): VerifiedAgentToken
    {
        if ($rawToken === '') {
            throw new AgentTokenVerificationException('Token is empty');
        }

        try {
            $config = Configuration::forAsymmetricSigner(
                new Sha256(),
                InMemory::plainText('empty', 'empty'),
                InMemory::plainText($this->publicKeyPem),
            );

            $token = $config->parser()->parse($rawToken);
            if (!$token instanceof Plain) {
                throw new AgentTokenVerificationException('Token is not a Plain JWT');
            }

            $config->validator()->assert(
                $token,
                new SignedWith($config->signer(), $config->verificationKey()),
                new IssuedBy($this->issuer),
                new PermittedFor($this->audience),
                new StrictValidAt(new FrozenClock($this->clock->now())),
            );
        } catch (AgentTokenVerificationException $e) {
            throw $e;
        } catch (\Throwable $e) {
            throw new AgentTokenVerificationException('Token verification failed', 0, $e);
        }

        return $this->extractClaims($token);
    }

    /**
     * @throws AgentTokenVerificationException
     */
    private function extractClaims(Plain $token): VerifiedAgentToken
    {
        $claims = $token->claims();

        $sub = $claims->get('sub');
        if (!is_string($sub) || $sub === '') {
            throw new AgentTokenVerificationException('Missing or invalid sub claim');
        }

        $fhirUser = $claims->get('fhirUser');
        if (!is_string($fhirUser) || $fhirUser === '') {
            throw new AgentTokenVerificationException('Missing or invalid fhirUser claim');
        }

        $scopes = $claims->get('scopes');
        if (!is_array($scopes)) {
            throw new AgentTokenVerificationException('Missing or invalid scopes claim');
        }
        $scopeList = [];
        foreach ($scopes as $scope) {
            if (!is_string($scope)) {
                throw new AgentTokenVerificationException('Scope is not a string');
            }
            $scopeList[] = $scope;
        }

        $jti = $claims->get('jti');
        if (!is_string($jti) || $jti === '') {
            throw new AgentTokenVerificationException('Missing or invalid jti claim');
        }

        return new VerifiedAgentToken(
            subject: $sub,
            fhirUser: $fhirUser,
            scopes: $scopeList,
            jti: $jti,
            audience: $this->audience,
            issuer: $this->issuer,
        );
    }
}
