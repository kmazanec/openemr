<?php

namespace OpenEMR\RestControllers\Authorization;

use League\OAuth2\Server\Exception\OAuthServerException;
use OpenEMR\Common\Http\HttpRestRequest;
use OpenEMR\Common\Utils\HttpUtils;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

class OAuth2PublicJsonWebKeyController
{
    public function __construct(private readonly string $publicKeyPath)
    {
        // Constructor can be used for dependency injection if needed
    }

    /**
     * @param HttpRestRequest $request
     * @return Response
     * @throws OAuthServerException
     */
    public function getJsonWebKeyResponse(HttpRestRequest $request): Response
    {
        $public = file_get_contents($this->publicKeyPath);
        if ($public === false) {
            throw OAuthServerException::serverError("Failed to read public key file");
        }
        $keyPublic = openssl_pkey_get_details(openssl_pkey_get_public($public));
        if ($keyPublic === false) {
            throw OAuthServerException::serverError("Failed to parse public key");
        }
        // Stable kid derived from the SPKI hash so verifiers can pin a key
        // and rotation produces a new kid automatically. Required by RFC 7517
        // §4.5 for any deployment that may publish more than one key.
        $publicKeyPem = $keyPublic['key'] ?? null;
        if (!is_string($publicKeyPem) || $publicKeyPem === '') {
            throw OAuthServerException::serverError("Public key details missing PEM body");
        }
        $kid = rtrim(strtr(base64_encode(hash('sha256', $publicKeyPem, true)), '+/', '-_'), '=');

        $key_info = [
            'kty' => 'RSA',
            'n' => HttpUtils::base64url_encode($keyPublic['rsa']['n']),
            'e' => HttpUtils::base64url_encode($keyPublic['rsa']['e']),
            'alg' => 'RS256',
            'use' => 'sig',
            'kid' => $kid,
        ];

        $jsonData = ['keys' => [$key_info]];

        $request->getSession()->invalidate();
        return new JsonResponse($jsonData);
    }
}
