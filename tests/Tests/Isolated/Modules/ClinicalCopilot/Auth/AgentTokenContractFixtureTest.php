<?php

/**
 * Generates the cross-boundary contract fixture consumed by the agent's
 * Vitest verifier test (`agent/tests/auth/contract.test.ts`).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Auth;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\JwksKeyId;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use PHPUnit\Framework\TestCase;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';

/**
 * Smoke-checks the PHP-side minter end-to-end: generates an RSA keypair,
 * mints a token, derives the matching JWK, and writes the manifest to a
 * tmp file. The agent's Vitest contract test reads a *committed* fixture
 * at `agent/tests/fixtures/contract/token.json`, not whatever this test
 * produces — the two are independent.
 *
 * The temp-file output is purely a developer aid for refreshing the
 * committed fixture by hand. The path is logged at the end of the test
 * so you can find it after a run.
 *
 * To refresh the committed agent fixture:
 *   composer phpunit-isolated -- --filter AgentTokenContractFixture
 *   cp <printed-temp-path> agent/tests/fixtures/contract/token.json
 */
final class AgentTokenContractFixtureTest extends TestCase
{
    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_AUTH_DIR . '/AgentTokenMintException.php';
        require_once self::MODULE_AUTH_DIR . '/AgentSigningKey.php';
        require_once self::MODULE_AUTH_DIR . '/JwksKeyId.php';
        require_once self::MODULE_AUTH_DIR . '/SystemClock.php';
        require_once self::MODULE_AUTH_DIR . '/RandomJtiGenerator.php';
        require_once self::MODULE_AUTH_DIR . '/ResolvedFhirUser.php';
        require_once self::MODULE_AUTH_DIR . '/AgentTokenMinter.php';
    }

    public function testMinterProducesAVerifiableManifest(): void
    {
        $resource = openssl_pkey_new([
            'private_key_bits' => 2048,
            'private_key_type' => OPENSSL_KEYTYPE_RSA,
        ]);
        $this->assertNotFalse($resource);
        $privatePem = '';
        openssl_pkey_export($resource, $privatePem);
        $this->assertIsString($privatePem);
        $this->assertNotSame('', $privatePem, 'openssl_pkey_export must populate $privatePem');
        $details = openssl_pkey_get_details($resource);
        $this->assertNotFalse($details);
        $publicPem = $details['key'] ?? null;
        $this->assertIsString($publicPem);
        $this->assertNotSame('', $publicPem);

        $issuer = 'https://emr.contract.test/oauth2/default';
        $fhirBase = 'https://emr.contract.test/apis/default/fhir';
        $uuid = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';
        $scopes = [
            'openid',
            'fhirUser',
            'user/Patient.rs',
            'user/Observation.rs',
        ];

        $minter = new AgentTokenMinter(
            new AgentSigningKey($privatePem, $publicPem, null),
        );
        $token = $minter->mint(
            new ResolvedFhirUser($uuid, $fhirBase . '/Practitioner/' . $uuid),
            $scopes,
            $issuer,
        );

        $kid = JwksKeyId::fromPublicKey($publicPem);
        $jwk = $this->publicPemToJwk($publicPem, $kid);

        $manifest = [
            'token' => $token,
            'jwk' => $jwk,
            'expected' => [
                'issuer' => $issuer,
                'audience' => AgentTokenMinter::AGENT_CLIENT_ID,
                'sub' => $uuid,
                'fhirUser' => $fhirBase . '/Practitioner/' . $uuid,
                'scopes' => $scopes,
                'kid' => $kid,
                'alg' => 'RS256',
            ],
            'generatedAt' => (new DateTimeImmutable())->format(DATE_ATOM),
        ];

        $tmpPath = tempnam(sys_get_temp_dir(), 'agent-contract-') . '.json';
        $bytes = file_put_contents(
            $tmpPath,
            json_encode($manifest, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n",
        );
        $this->assertNotFalse($bytes, 'Manifest must write successfully');
        fwrite(STDERR, "agent contract manifest written to: {$tmpPath}\n");
    }

    /**
     * @return array<string, string>
     */
    private function publicPemToJwk(string $publicPem, string $kid): array
    {
        $resource = openssl_pkey_get_public($publicPem);
        $this->assertNotFalse($resource);
        $details = openssl_pkey_get_details($resource);
        $this->assertNotFalse($details);
        $rsa = $details['rsa'] ?? null;
        $this->assertIsArray($rsa);
        $modulus = $rsa['n'] ?? null;
        $exponent = $rsa['e'] ?? null;
        $this->assertIsString($modulus);
        $this->assertIsString($exponent);

        $base64Url = static fn (string $raw): string => rtrim(
            strtr(base64_encode($raw), '+/', '-_'),
            '=',
        );

        return [
            'kty' => 'RSA',
            'n' => $base64Url($modulus),
            'e' => $base64Url($exponent),
            'alg' => 'RS256',
            'use' => 'sig',
            'kid' => $kid,
        ];
    }
}
