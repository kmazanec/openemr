<?php

/**
 * Isolated tests for the Agent JWT minter.
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
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMintException;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\JwksKeyId;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use PHPUnit\Framework\TestCase;

// The helper classes `FixedClock` and `FixedJtiGenerator` at the bottom of
// this file `implements` interfaces from the module. PHP resolves the
// `implements` clause when the file is loaded — before `setUpBeforeClass`
// runs — so the interfaces must be available at file-load time. Pull them
// in here rather than relying on the runtime autoloader, which is not
// active during `composer phpunit-isolated`.
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';

/**
 * Asserts every claim and header bit on the minted JWT.
 *
 * The minter is the trust-boundary contract between OpenEMR (issuer) and
 * the agent service (verifier). A typo in any of `aud`, `iss`, `sub`,
 * `fhirUser`, `scopes`, `kid`, or `alg` here either fails-closed (bad —
 * 401s with no signal pointing at the typo) or fails-open (worse).
 * These cases are the cheapest way to catch that class of regression
 * before it ships.
 */
final class AgentTokenMinterTest extends TestCase
{
    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    private const ISSUER = 'https://emr.example.test/oauth2/default';

    private const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';

    private const FHIR_UUID = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';

    private const FIXED_NOW = '2026-04-30T12:00:00+00:00';

    private const FIXED_JTI = 'fixed-jti-for-tests';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_AUTH_DIR . '/AgentTokenMintException.php';
        require_once self::MODULE_AUTH_DIR . '/AgentSigningKey.php';
        require_once self::MODULE_AUTH_DIR . '/JwksKeyId.php';
        require_once self::MODULE_AUTH_DIR . '/ClockInterface.php';
        require_once self::MODULE_AUTH_DIR . '/SystemClock.php';
        require_once self::MODULE_AUTH_DIR . '/JtiGenerator.php';
        require_once self::MODULE_AUTH_DIR . '/RandomJtiGenerator.php';
        require_once self::MODULE_AUTH_DIR . '/ResolvedFhirUser.php';
        require_once self::MODULE_AUTH_DIR . '/AgentTokenMinter.php';

        // Generate one keypair for the whole class — RSA generation is
        // expensive and the keys are not under test, only the minter is.
        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    /**
     * @return array{private: string, public: string}
     */
    private static function keypair(): array
    {
        if (self::$keypair === null) {
            self::fail('keypair was not initialized in setUpBeforeClass');
        }
        return self::$keypair;
    }

    /**
     * @return array{private: string, public: string}
     */
    private static function generateKeypair(): array
    {
        $resource = openssl_pkey_new([
            'private_key_bits' => 2048,
            'private_key_type' => OPENSSL_KEYTYPE_RSA,
        ]);
        if ($resource === false) {
            self::fail('openssl_pkey_new returned false — cannot run minter tests');
        }
        $privatePem = '';
        openssl_pkey_export($resource, $privatePem);
        self::assertIsString($privatePem);
        self::assertNotSame('', $privatePem);
        $details = openssl_pkey_get_details($resource);
        self::assertNotFalse($details);
        $publicPem = $details['key'] ?? null;
        self::assertIsString($publicPem);
        return ['private' => $privatePem, 'public' => $publicPem];
    }

    public function testMintedTokenCarriesAllRequiredClaims(): void
    {
        $token = $this->mint(['user/Patient.rs', 'user/Observation.rs']);
        [$header, $payload] = $this->decodeUnverified($token);

        $this->assertSame('JWT', $header['typ'] ?? null);
        $this->assertSame('RS256', $header['alg'] ?? null);
        $this->assertSame(JwksKeyId::fromPublicKey(self::keypair()['public']), $header['kid'] ?? null);

        $this->assertSame(self::FHIR_UUID, $payload['sub'] ?? null, 'sub must be the bare uuid');
        $this->assertSame(
            self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
            $payload['fhirUser'] ?? null,
            'fhirUser claim must be the SMART URI',
        );
        $this->assertSame('openemr-clinical-copilot-agent', $payload['aud'] ?? null);
        $this->assertSame(self::ISSUER, $payload['iss'] ?? null);
        $this->assertSame(['user/Patient.rs', 'user/Observation.rs'], $payload['scopes'] ?? null);
        $this->assertSame(self::FIXED_JTI, $payload['jti'] ?? null);

        $now = (new DateTimeImmutable(self::FIXED_NOW))->getTimestamp();
        $this->assertSame($now, $payload['iat'] ?? null);
        $this->assertSame($now, $payload['nbf'] ?? null);
        $this->assertSame($now + 300, $payload['exp'] ?? null, '5-minute TTL');
    }

    public function testEmptyScopesProducesEmptyArrayClaim(): void
    {
        $token = $this->mint([]);
        [, $payload] = $this->decodeUnverified($token);
        $this->assertSame([], $payload['scopes'] ?? null);
    }

    public function testKidIsStableAcrossMintsForTheSameKey(): void
    {
        $a = $this->mint([]);
        $b = $this->mint([]);
        [$headerA] = $this->decodeUnverified($a);
        [$headerB] = $this->decodeUnverified($b);
        $this->assertSame($headerA['kid'], $headerB['kid']);
    }

    public function testDifferentKeyProducesDifferentKid(): void
    {
        $other = self::generateKeypair();
        $kidA = JwksKeyId::fromPublicKey(self::keypair()['public']);
        $kidB = JwksKeyId::fromPublicKey($other['public']);
        $this->assertNotSame($kidA, $kidB);
    }

    public function testEmptyPrivateKeyFailsClosed(): void
    {
        $this->expectException(AgentTokenMintException::class);
        new AgentSigningKey('', self::keypair()['public'], null);
    }

    public function testEmptyPublicKeyFailsClosed(): void
    {
        $this->expectException(AgentTokenMintException::class);
        new AgentSigningKey(self::keypair()['private'], '', null);
    }

    /**
     * @param list<string> $scopes
     */
    private function mint(array $scopes): string
    {
        $minter = new AgentTokenMinter(
            signingKey: new AgentSigningKey(
                self::keypair()['private'],
                self::keypair()['public'],
                null,
            ),
            clock: new FixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            jtiGenerator: new FixedJtiGenerator(self::FIXED_JTI),
        );
        return $minter->mint(
            new ResolvedFhirUser(
                self::FHIR_UUID,
                self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
            ),
            $scopes,
            self::ISSUER,
        );
    }

    /**
     * @return array{0: array<string, mixed>, 1: array<string, mixed>}
     */
    private function decodeUnverified(string $token): array
    {
        $parts = explode('.', $token);
        $this->assertCount(3, $parts, 'JWT must have header.payload.signature');
        return [self::decodeSegment($parts[0]), self::decodeSegment($parts[1])];
    }

    /**
     * @return array<string, mixed>
     */
    private static function decodeSegment(string $segment): array
    {
        $padded = strtr($segment, '-_', '+/');
        $padded .= str_repeat('=', (4 - strlen($padded) % 4) % 4);
        $json = base64_decode($padded, true);
        self::assertNotFalse($json);
        $decoded = json_decode($json, true, flags: JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);
        $result = [];
        foreach ($decoded as $key => $value) {
            self::assertIsString($key, 'JWT segment must decode to a string-keyed map');
            $result[$key] = $value;
        }
        return $result;
    }
}

final readonly class FixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class FixedJtiGenerator implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}
