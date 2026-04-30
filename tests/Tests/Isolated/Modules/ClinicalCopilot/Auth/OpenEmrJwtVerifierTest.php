<?php

/**
 * Isolated tests for OpenEmrJwtVerifier — the PHP-side verifier the
 * agent-callback snapshot endpoint uses.
 *
 * The minter (PHP) and the agent's TS verifier already have their own
 * tests. This file covers the PHP→PHP loop: tokens we minted ourselves
 * coming back through the OpenEMR side via the agent's callback.
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
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenVerificationException;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use PHPUnit\Framework\TestCase;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';

final class OpenEmrJwtVerifierTest extends TestCase
{
    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    public const ISSUER = 'https://emr.example.test/oauth2/default';

    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';

    public const FHIR_UUID = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';

    public const FIXED_NOW = '2026-04-30T12:00:00+00:00';

    public const FIXED_JTI = 'fixed-jti-for-tests';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        $files = [
            'AgentTokenMintException.php',
            'AgentTokenVerificationException.php',
            'AgentSigningKey.php',
            'JwksKeyId.php',
            'ClockInterface.php',
            'SystemClock.php',
            'JtiGenerator.php',
            'RandomJtiGenerator.php',
            'ResolvedFhirUser.php',
            'AgentTokenMinter.php',
            'VerifiedAgentToken.php',
            'OpenEmrJwtVerifier.php',
        ];
        foreach ($files as $f) {
            require_once self::MODULE_AUTH_DIR . '/' . $f;
        }

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    public function testHappyPathReturnsVerifiedToken(): void
    {
        $token = $this->mint(['user/Patient.rs', 'user/Condition.rs']);

        $verified = $this->verifier()->verify($token);

        $this->assertSame(self::FHIR_UUID, $verified->subject);
        $this->assertSame(self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID, $verified->fhirUser);
        $this->assertSame(['user/Patient.rs', 'user/Condition.rs'], $verified->scopes);
        $this->assertSame(self::FIXED_JTI, $verified->jti);
        $this->assertSame('openemr-clinical-copilot-agent', $verified->audience);
        $this->assertSame(self::ISSUER, $verified->issuer);
    }

    public function testEmptyTokenIsRejected(): void
    {
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify('');
    }

    public function testMalformedTokenIsRejected(): void
    {
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify('not.a.jwt');
    }

    public function testWrongIssuerIsRejected(): void
    {
        $token = $this->mint(['user/Patient.rs'], issuer: 'https://attacker.example/oauth2/default');
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify($token);
    }

    public function testWrongAudienceIsRejected(): void
    {
        // Mint with the production minter (correct aud), then re-build a
        // token with a different aud claim to simulate aud-substitution.
        $token = $this->mintWithCustomAudience('attacker-client');
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify($token);
    }

    public function testExpiredTokenIsRejected(): void
    {
        // Mint at time T, verify at time T + 6 minutes — token TTL is 5 min.
        $token = $this->mint(['user/Patient.rs']);
        $expiredVerifier = $this->verifierAt('2026-04-30T12:06:00+00:00');
        $this->expectException(AgentTokenVerificationException::class);
        $expiredVerifier->verify($token);
    }

    public function testNotYetValidTokenIsRejected(): void
    {
        // Verify at time T - 1 minute (before nbf).
        $token = $this->mint(['user/Patient.rs']);
        $earlyVerifier = $this->verifierAt('2026-04-30T11:59:00+00:00');
        $this->expectException(AgentTokenVerificationException::class);
        $earlyVerifier->verify($token);
    }

    public function testTamperedSignatureIsRejected(): void
    {
        $token = $this->mint(['user/Patient.rs']);
        // Mutate the payload to break the signature.
        [$h, $p, $s] = explode('.', $token);
        $tampered = $h . '.' . $p . 'A.' . $s;
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify($tampered);
    }

    public function testTokenSignedWithDifferentKeyIsRejected(): void
    {
        $other = self::generateKeypair();
        $token = $this->mintWithKeypair($other);
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify($token);
    }

    public function testMissingFhirUserClaimIsRejected(): void
    {
        $token = $this->mintWithoutClaim('fhirUser');
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify($token);
    }

    public function testMissingScopesClaimIsRejected(): void
    {
        $token = $this->mintWithoutClaim('scopes');
        $this->expectException(AgentTokenVerificationException::class);
        $this->verifier()->verify($token);
    }

    private function verifier(): OpenEmrJwtVerifier
    {
        return $this->verifierAt(self::FIXED_NOW);
    }

    private function verifierAt(string $isoNow): OpenEmrJwtVerifier
    {
        return new OpenEmrJwtVerifier(
            publicKeyPem: self::keypair()['public'],
            issuer: self::ISSUER,
            audience: AgentTokenMinter::AGENT_CLIENT_ID,
            clock: new VerifierTestFixedClock(new DateTimeImmutable($isoNow)),
        );
    }

    /**
     * @param list<string> $scopes
     */
    private function mint(array $scopes, ?string $issuer = null): string
    {
        return $this->buildMinter(self::keypair()['private'], self::keypair()['public'])
            ->mint(
                new ResolvedFhirUser(
                    uuid: self::FHIR_UUID,
                    fhirUserUri: self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
                ),
                $scopes,
                $issuer ?? self::ISSUER,
            );
    }

    /**
     * @param array{private: string, public: string} $keypair
     */
    private function mintWithKeypair(array $keypair): string
    {
        return $this->buildMinter($keypair['private'], $keypair['public'])
            ->mint(
                new ResolvedFhirUser(
                    uuid: self::FHIR_UUID,
                    fhirUserUri: self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
                ),
                [],
                self::ISSUER,
            );
    }

    private function buildMinter(string $privatePem, string $publicPem): AgentTokenMinter
    {
        return new AgentTokenMinter(
            new AgentSigningKey($privatePem, $publicPem, null),
            new VerifierTestFixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            new VerifierTestFixedJtiGenerator(self::FIXED_JTI),
        );
    }

    private function mintWithCustomAudience(string $aud): string
    {
        // Hand-build a token with the wrong aud since AgentTokenMinter pins
        // the audience constant.
        return $this->buildRawToken(payload: [
            'aud' => $aud,
            'iss' => self::ISSUER,
            'sub' => self::FHIR_UUID,
            'fhirUser' => self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
            'scopes' => [],
            'jti' => self::FIXED_JTI,
            'iat' => (new DateTimeImmutable(self::FIXED_NOW))->getTimestamp(),
            'nbf' => (new DateTimeImmutable(self::FIXED_NOW))->getTimestamp(),
            'exp' => (new DateTimeImmutable(self::FIXED_NOW))->getTimestamp() + 300,
        ]);
    }

    private function mintWithoutClaim(string $claim): string
    {
        $now = (new DateTimeImmutable(self::FIXED_NOW))->getTimestamp();
        $payload = [
            'aud' => AgentTokenMinter::AGENT_CLIENT_ID,
            'iss' => self::ISSUER,
            'sub' => self::FHIR_UUID,
            'fhirUser' => self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
            'scopes' => [],
            'jti' => self::FIXED_JTI,
            'iat' => $now,
            'nbf' => $now,
            'exp' => $now + 300,
        ];
        unset($payload[$claim]);
        return $this->buildRawToken($payload);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function buildRawToken(array $payload): string
    {
        // Sign manually so we can omit/override claims AgentTokenMinter
        // always sets. RS256 with the test keypair.
        $header = ['typ' => 'JWT', 'alg' => 'RS256'];
        $encode = static fn(array $a): string => rtrim(
            strtr(base64_encode(json_encode($a, JSON_THROW_ON_ERROR)), '+/', '-_'),
            '=',
        );
        $signingInput = $encode($header) . '.' . $encode($payload);
        $signature = '';
        $ok = openssl_sign($signingInput, $signature, self::keypair()['private'], OPENSSL_ALGO_SHA256);
        self::assertTrue($ok, 'openssl_sign failed in test');
        self::assertIsString($signature);
        $sig = rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');
        return $signingInput . '.' . $sig;
    }

    /**
     * @return array{private: string, public: string}
     */
    private static function keypair(): array
    {
        if (self::$keypair === null) {
            self::fail('keypair not initialized');
        }
        return self::$keypair;
    }

    /**
     * @return array{private: string, public: string}
     */
    private static function generateKeypair(): array
    {
        $r = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        self::assertNotFalse($r);
        $priv = '';
        openssl_pkey_export($r, $priv);
        $details = openssl_pkey_get_details($r);
        self::assertNotFalse($details);
        $pub = $details['key'];
        self::assertIsString($pub);
        self::assertIsString($priv);
        return ['private' => $priv, 'public' => $pub];
    }
}

final readonly class VerifierTestFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class VerifierTestFixedJtiGenerator implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}
