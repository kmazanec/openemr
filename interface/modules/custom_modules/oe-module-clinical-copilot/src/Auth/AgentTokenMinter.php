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
use DateTimeImmutable;
use League\OAuth2\Server\CryptKey;
use OpenEMR\Common\Auth\OAuth2KeyConfig;
use OpenEMR\Common\Auth\OpenIDConnect\Entities\AccessTokenEntity;
use OpenEMR\Common\Auth\OpenIDConnect\Entities\ClientEntity;
use OpenEMR\Common\Auth\OpenIDConnect\Entities\ScopeEntity;

/**
 * Mints a short-lived RS-signed JWT for the Agent service.
 *
 * PRESEARCH §18 commits to invoking OpenEMR's existing League OAuth2 server
 * "directly" — i.e. without a self-loopback HTTP call to /oauth2/{site}/token.
 * The full grant pipeline (CustomClientCredentialsGrant et al.) requires a
 * registered oauth_clients row and a PSR-7 token request, neither of which
 * is appropriate for an in-process internal hop. Instead this class uses
 * League's AccessTokenEntity + CryptKey directly — same library, same key
 * material, same RSA signing — and produces a JWT the agent service can
 * verify with the matching public key.
 *
 * Token contract:
 *   - sub: the acting user's fhirUser uuid (Practitioner/{uuid})
 *   - aud: the agent client identifier ("openemr-clinical-copilot-agent")
 *   - iss: this OpenEMR site's base URL
 *   - scope: the per-action allowlist resolved by PolicyGate
 *   - 5-minute TTL — does not outlive a single agent request (PRESEARCH §18)
 *   - jti: per-mint UUID
 */
final readonly class AgentTokenMinter
{
    public const AGENT_CLIENT_ID = 'openemr-clinical-copilot-agent';

    private const TOKEN_TTL = 'PT5M';

    private OAuth2KeyConfig $keyConfig;

    public function __construct(?OAuth2KeyConfig $keyConfig = null)
    {
        try {
            // OAuth2KeyConfig::__construct() creates the keys on first use
            // if missing, matching the AuthorizationController bootstrap.
            $this->keyConfig = $keyConfig ?? new OAuth2KeyConfig();
            $this->keyConfig->configKeyPairs();
        } catch (\Throwable $e) {
            throw new AgentTokenMintException('OAuth2 key material unavailable', 0, $e);
        }
    }

    /**
     * @param list<string> $scopes SMART scope strings, already filtered by PolicyGate.
     *
     * @throws AgentTokenMintException
     */
    public function mint(SessionContext $session, array $scopes, string $issuer): string
    {
        $client = new ClientEntity();
        $client->setIdentifier(self::AGENT_CLIENT_ID);

        $token = new AccessTokenEntity();
        $token->setIdentifier(self::generateJti());
        $token->setClient($client);
        $token->setUserIdentifier($session->fhirUserUuid ?? $session->authUserId);
        $token->setIssuer($issuer);

        $now = new DateTimeImmutable();
        $token->setExpiryDateTime($now->add(new DateInterval(self::TOKEN_TTL)));

        foreach ($scopes as $scopeString) {
            $scope = new ScopeEntity();
            $scope->setIdentifier($scopeString);
            $token->addScope($scope);
        }

        $privateKeyPath = $this->keyConfig->getPrivateKeyLocation();
        $passphrase = $this->keyConfig->getPassPhrase();
        if (!is_string($privateKeyPath) || $privateKeyPath === '') {
            throw new AgentTokenMintException('OAuth2 private key path is not configured');
        }
        if ($passphrase !== null && !is_string($passphrase)) {
            throw new AgentTokenMintException('OAuth2 passphrase is malformed');
        }

        try {
            $token->setPrivateKey(new CryptKey($privateKeyPath, $passphrase));
            return (string) $token;
        } catch (\Throwable $e) {
            throw new AgentTokenMintException('Failed to sign agent JWT', 0, $e);
        }
    }

    private static function generateJti(): string
    {
        return bin2hex(random_bytes(16));
    }
}
