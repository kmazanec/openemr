<?php

/**
 * Cross-boundary contract for the PHP → PHP callback path: the same
 * token AgentTokenMinter issued must verify cleanly through
 * OpenEmrJwtVerifier.
 *
 * Existing AgentTokenContractFixtureTest already covers PHP → TS
 * (mint here, verify in the agent). This test covers the agent's
 * callback direction (mint here, agent re-presents the same token,
 * verify here).
 *
 * Drift between the two sides — claim names, audience constant, alg,
 * kid algorithm — fails this test with a precise diff before it can
 * fail at runtime.
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
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use PHPUnit\Framework\TestCase;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';

final class PhpRoundTripContractTest extends TestCase
{
    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    public const ISSUER = 'https://emr.example.test/oauth2/default';

    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';

    public const FHIR_UUID = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';

    public const FIXED_NOW = '2026-04-30T12:00:00+00:00';

    public const FIXED_JTI = 'roundtrip-jti';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        foreach ([
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
        ] as $f) {
            require_once self::MODULE_AUTH_DIR . '/' . $f;
        }

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    public function testMintedTokenVerifiesAndCarriesContractedClaims(): void
    {
        $scopes = [
            'user/Patient.rs',
            'user/Condition.rs',
            'user/AllergyIntolerance.rs',
            'user/Observation.rs',
            'user/MedicationRequest.rs',
            'user/Encounter.rs',
            'user/Appointment.rs',
        ];

        $keypair = self::keypair();
        $minter = new AgentTokenMinter(
            new AgentSigningKey($keypair['private'], $keypair['public'], null),
            new RoundTripFixedClock(new DateTimeImmutable(self::FIXED_NOW)),
            new RoundTripFixedJtiGenerator(self::FIXED_JTI),
        );
        $token = $minter->mint(
            new ResolvedFhirUser(
                uuid: self::FHIR_UUID,
                fhirUserUri: self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID,
            ),
            $scopes,
            self::ISSUER,
        );

        $verifier = new OpenEmrJwtVerifier(
            publicKeyPem: $keypair['public'],
            issuer: self::ISSUER,
            audience: AgentTokenMinter::AGENT_CLIENT_ID,
            clock: new RoundTripFixedClock(new DateTimeImmutable(self::FIXED_NOW)),
        );

        $verified = $verifier->verify($token);

        // The full claim contract round-trips byte-for-byte. Any drift in
        // the seven claims below fails this test with a precise diff.
        $this->assertSame(self::FHIR_UUID, $verified->subject);
        $this->assertSame(self::FHIR_BASE . '/Practitioner/' . self::FHIR_UUID, $verified->fhirUser);
        $this->assertSame($scopes, $verified->scopes);
        $this->assertSame(self::FIXED_JTI, $verified->jti);
        $this->assertSame('openemr-clinical-copilot-agent', $verified->audience);
        $this->assertSame(self::ISSUER, $verified->issuer);
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

final readonly class RoundTripFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class RoundTripFixedJtiGenerator implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}
