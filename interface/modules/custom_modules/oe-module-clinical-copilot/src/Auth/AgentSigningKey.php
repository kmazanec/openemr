<?php

/**
 * Signing key material for the Agent JWT minter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

use OpenEMR\Common\Auth\OAuth2KeyConfig;

/**
 * In-memory bundle of the PEM bytes the minter needs.
 *
 * Production wiring goes through `OAuth2KeyConfig` which reads the keys
 * off disk and the passphrase from the encrypted DB. Isolated tests can
 * bypass that by constructing the value object directly with fixture
 * keys — no Docker, no DB, no superglobals.
 */
final readonly class AgentSigningKey
{
    /**
     * @phpstan-var non-empty-string
     */
    public string $privateKeyPem;

    /**
     * @phpstan-var non-empty-string
     */
    public string $publicKeyPem;

    public function __construct(
        string $privateKeyPem,
        string $publicKeyPem,
        public ?string $passphrase,
    ) {
        if ($privateKeyPem === '') {
            throw new AgentTokenMintException('Private key PEM is empty');
        }
        if ($publicKeyPem === '') {
            throw new AgentTokenMintException('Public key PEM is empty');
        }
        $this->privateKeyPem = $privateKeyPem;
        $this->publicKeyPem = $publicKeyPem;
    }

    /**
     * Production factory — reads OpenEMR's OAuth2 keys via `OAuth2KeyConfig`.
     */
    public static function fromOAuth2KeyConfig(?OAuth2KeyConfig $config = null): self
    {
        try {
            $config ??= new OAuth2KeyConfig();
            $config->configKeyPairs();
        } catch (\Throwable $e) {
            throw new AgentTokenMintException('OAuth2 key material unavailable', 0, $e);
        }

        $privatePath = $config->getPrivateKeyLocation();
        $publicPath = $config->getPublicKeyLocation();
        $passphrase = $config->getPassPhrase();

        if (!is_string($privatePath) || $privatePath === '') {
            throw new AgentTokenMintException('OAuth2 private key path is not configured');
        }
        if (!is_string($publicPath) || $publicPath === '') {
            throw new AgentTokenMintException('OAuth2 public key path is not configured');
        }
        if ($passphrase !== null && !is_string($passphrase)) {
            throw new AgentTokenMintException('OAuth2 passphrase is malformed');
        }

        $privatePem = @file_get_contents($privatePath);
        $publicPem = @file_get_contents($publicPath);
        if ($privatePem === false || $privatePem === '') {
            throw new AgentTokenMintException('OAuth2 private key is unreadable');
        }
        if ($publicPem === false || $publicPem === '') {
            throw new AgentTokenMintException('OAuth2 public key is unreadable');
        }

        return new self($privatePem, $publicPem, $passphrase);
    }
}
