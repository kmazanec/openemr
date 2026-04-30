<?php

/**
 * Stable key id derived from the OAuth2 public key.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Auth;

/**
 * Computes a JWS `kid` from the public key's PEM-encoded SubjectPublicKeyInfo.
 *
 * Why a hash and not, say, the file mtime or a config value:
 *   - It is stable across deploys for the same key — agents can cache the
 *     JWKS by `kid` without invalidation games.
 *   - Rotating the keypair changes the `kid` automatically. During overlap
 *     (old + new keys both in JWKS) the agent matches by kid; without one,
 *     `jose` falls back to the first key in the set, which is undefined.
 *   - It does not embed any secret material.
 *
 * The same algorithm runs on the JWKS endpoint
 * (`OAuth2PublicJsonWebKeyController`) so the `kid` here matches the
 * `kid` published in the JWKS. The hash input is the PEM string from
 * `openssl_pkey_get_details(...)['key']` — both sides extract it that way,
 * so they agree byte-for-byte.
 */
final class JwksKeyId
{
    public static function fromPublicKey(string $publicKeyPem): string
    {
        $resource = openssl_pkey_get_public($publicKeyPem);
        if ($resource === false) {
            throw new \RuntimeException('Public key is not a valid PEM-encoded RSA key');
        }
        $details = openssl_pkey_get_details($resource);
        if ($details === false || !isset($details['key']) || !is_string($details['key'])) {
            throw new \RuntimeException('Could not read public key details');
        }

        $hash = hash('sha256', $details['key'], binary: true);
        return rtrim(strtr(base64_encode($hash), '+/', '-_'), '=');
    }
}
