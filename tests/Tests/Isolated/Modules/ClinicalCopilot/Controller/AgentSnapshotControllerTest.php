<?php

/**
 * Isolated tests for AgentSnapshotController.
 *
 * Drives the controller end-to-end through the §2.5 archetype factory:
 * verified token → ACL → snapshot build → disclosure dispatch → JSON
 * response. Production DataSource implementations are exercised
 * separately (Phase §2.5b services suite); here the focus is
 * authorization, scope-vs-category enforcement, exactly-once event
 * dispatch, and the JSON shape contract.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Controller;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Controller\AgentSnapshotController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\DisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\ArchetypeChartFactory;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryAllergyDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryAppointmentDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryConditionDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryEncounterDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryMedicationDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryObservationDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryPatientDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\RequireModuleClasses;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Symfony\Component\EventDispatcher\EventDispatcher;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentActorResolver.php';

final class AgentSnapshotControllerTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';

    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';

    public const FIXED_NOW = '2026-04-30T12:00:00+00:00';

    public const FIXED_JTI = 'test-jti-snapshot';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        RequireModuleClasses::load();

        $auth = self::MODULE_DIR . '/Auth';
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
            'ResolvedAgentActor.php',
            'AgentActorResolver.php',
        ] as $f) {
            require_once $auth . '/' . $f;
        }
        require_once self::MODULE_DIR . '/Controller/AgentSnapshotController.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    public function testMissingTokenReturns401(): void
    {
        [$status, $body] = $this->dispatch(token: null, pid: 4242);
        $this->assertSame(401, $status);
        $this->assertSame(['error' => 'missing_token'], $body);
    }

    public function testInvalidTokenReturns401(): void
    {
        [$status, $body] = $this->dispatch(token: 'not.a.jwt', pid: 4242);
        $this->assertSame(401, $status);
        $this->assertSame(['error' => 'invalid_token'], $body);
    }

    public function testMissingPidReturns400(): void
    {
        [$status, $body] = $this->dispatch(token: $this->validToken(), pid: null);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_pid'], $body);
    }

    public function testActorNotResolvedReturns403(): void
    {
        [$status, $body] = $this->dispatch(
            token: $this->validToken(),
            pid: 4242,
            forceUnresolvedActor: true,
        );
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'fhir_user_unresolved'], $body);
    }

    public function testAclDeniedReturns403(): void
    {
        [$status, $body] = $this->dispatch(
            token: $this->validToken(),
            pid: 4242,
            actor: new ResolvedAgentActor(7, 'denied-user', $this->actorUuid()),
            actorMayRead: false,
        );
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'acl_denied'], $body);
    }

    public function testCategoryNotPermittedByScopesReturns403(): void
    {
        // Token carries no condition scope; request asks for diagnosis →
        // 403 scope_not_permitted.
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatch(
            token: $token,
            pid: 4242,
            categories: ['diagnosis'],
        );
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testUnknownCategoryReturns403(): void
    {
        [$status, $body] = $this->dispatch(
            token: $this->validToken(),
            pid: 4242,
            categories: ['totally-fake'],
        );
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testHappyPathReturns200WithFullSnapshot(): void
    {
        [$status, $body, $events] = $this->runWithEventCapture(
            token: $this->validToken(),
            pid: 4242,
        );
        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertArrayHasKey('patient', $body);
        $this->assertArrayHasKey('diagnoses', $body);
        $this->assertArrayHasKey('medications', $body);
        $this->assertArrayHasKey('allergies', $body);
        $this->assertArrayHasKey('labs', $body);
        $this->assertArrayHasKey('encounters', $body);
        $this->assertArrayHasKey('appointment', $body);
        $this->assertCount(1, $events, 'exactly one disclosure event per request');

        $event = $events[0];
        $this->assertSame('snapshot', $event->action);
        $this->assertSame(4242, $event->patientPid);
        $this->assertSame(self::FIXED_JTI, $event->requestId);
        $this->assertSame(
            ['allergy', 'appointment', 'diagnosis', 'encounter', 'lab', 'medication'],
            $event->categories,
        );
    }

    public function testRegulatoryDisclosureFailureReturns503AndOmitsBody(): void
    {
        // Plan §2.4: emit disclosure before any chart data leaves OpenEMR.
        // A failure writing to extended_log must convert to a 503 with
        // an error envelope — never the snapshot body.
        $broken = new class implements DisclosureRecorder {
            public function record(AgentDisclosure $disclosure): never
            {
                throw new \RuntimeException('extended_log unavailable');
            }
        };
        [$status, $body] = $this->dispatch(
            token: $this->validToken(),
            pid: 4242,
            disclosureRecorder: $broken,
        );
        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'disclosure_unavailable'], $body);
    }

    public function testCategoryFilterMasksOmittedCategories(): void
    {
        // Request only diagnosis + medication — labs/encounters/appointment
        // must be empty/null even though the snapshot has data.
        [$status, $body, $events] = $this->runWithEventCapture(
            token: $this->validToken(),
            pid: 4242,
            categories: ['diagnosis', 'medication'],
        );
        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertNotEmpty($body['diagnoses']);
        $this->assertNotEmpty($body['medications']);
        $this->assertSame([], $body['labs'], 'labs must be masked');
        $this->assertSame([], $body['encounters'], 'encounters must be masked');
        $this->assertNull($body['appointment'], 'appointment must be masked');
        $this->assertSame([], $body['allergies'], 'allergies must be masked');

        $this->assertCount(1, $events);
        $this->assertSame(
            ['diagnosis', 'medication'],
            $events[0]->categories,
            'event categories reflect what was asked, sorted',
        );
    }

    /**
     * @param ?list<string> $categories
     * @return array{0: int, 1: ?array<string, mixed>}
     */
    private function dispatch(
        ?string $token,
        ?int $pid,
        ?array $categories = null,
        ?ResolvedAgentActor $actor = null,
        bool $actorMayRead = true,
        bool $forceUnresolvedActor = false,
        ?DisclosureRecorder $disclosureRecorder = null,
    ): array {
        [$status, $body, ] = $this->runWithEventCapture(
            $token,
            $pid,
            $categories,
            $actor,
            $actorMayRead,
            $forceUnresolvedActor,
            $disclosureRecorder,
        );
        return [$status, $body];
    }

    /**
     * @param ?list<string> $categories
     * @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>}
     */
    private function runWithEventCapture(
        ?string $token,
        ?int $pid,
        ?array $categories = null,
        ?ResolvedAgentActor $actor = null,
        bool $actorMayRead = true,
        bool $forceUnresolvedActor = false,
        ?DisclosureRecorder $disclosureRecorder = null,
    ): array {
        $chart = (new ArchetypeChartFactory(20260430))->build(PatientArchetype::Diabetic, pid: 4242);
        $resolverActor = $forceUnresolvedActor
            ? null
            : ($actor ?? new ResolvedAgentActor(7, 'patel', $this->actorUuid()));
        $resolver = new SnapshotControllerStubResolver($resolverActor, $actorMayRead);

        $disclosureSink = $disclosureRecorder ?? new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, new NullLogger()),
        );

        $controller = new AgentSnapshotController(
            verifier: new OpenEmrJwtVerifier(
                publicKeyPem: self::keypair()['public'],
                issuer: self::ISSUER,
                audience: AgentTokenMinter::AGENT_CLIENT_ID,
                clock: $this->fixedClock(),
            ),
            actorResolver: $resolver,
            patientAdapter: new PatientAdapter(new InMemoryPatientDataSource($chart)),
            conditionAdapter: new ConditionAdapter(new InMemoryConditionDataSource($chart)),
            medicationAdapter: new MedicationAdapter(new InMemoryMedicationDataSource($chart)),
            allergyAdapter: new AllergyAdapter(new InMemoryAllergyDataSource($chart)),
            observationAdapter: new ObservationAdapter(new InMemoryObservationDataSource($chart)),
            encounterAdapter: new EncounterAdapter(new InMemoryEncounterDataSource($chart)),
            appointmentAdapter: new AppointmentAdapter(new InMemoryAppointmentDataSource($chart)),
            eventDispatcher: $dispatcher,
            logger: new NullLogger(),
            siteId: 'default',
            clock: $this->fixedClock(),
        );

        ob_start();
        try {
            $controller->handle($token, $pid, $categories, null);
        } finally {
            $output = ob_get_clean();
        }

        $status = http_response_code();
        $this->assertIsInt($status, 'http_response_code must return int');

        $decoded = null;
        if ($output !== '') {
            $raw = json_decode((string) $output, true);
            $this->assertIsArray($raw);
            $stringKeyed = [];
            foreach ($raw as $key => $value) {
                $this->assertIsString($key);
                $stringKeyed[$key] = $value;
            }
            $decoded = $stringKeyed;
        }

        return [$status, $decoded, $requestLogSink->all()];
    }

    private function fixedClock(): ClockInterface
    {
        return new SnapshotControllerFixedClock(new DateTimeImmutable(self::FIXED_NOW));
    }

    private function fixedJti(): JtiGenerator
    {
        return new SnapshotControllerFixedJti(self::FIXED_JTI);
    }

    private function actorUuid(): string
    {
        return 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';
    }

    private function validToken(): string
    {
        return $this->mintToken([
            'user/Condition.rs',
            'user/MedicationRequest.rs',
            'user/AllergyIntolerance.rs',
            'user/Observation.rs',
            'user/Encounter.rs',
            'user/Appointment.rs',
        ]);
    }

    /**
     * @param list<string> $scopes
     */
    private function mintToken(array $scopes): string
    {
        $minter = new AgentTokenMinter(
            new AgentSigningKey(self::keypair()['private'], self::keypair()['public'], null),
            $this->fixedClock(),
            $this->fixedJti(),
        );
        return $minter->mint(
            new ResolvedFhirUser(
                uuid: $this->actorUuid(),
                fhirUserUri: self::FHIR_BASE . '/Practitioner/' . $this->actorUuid(),
            ),
            $scopes,
            self::ISSUER,
        );
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

final readonly class SnapshotControllerFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class SnapshotControllerFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class SnapshotControllerStubResolver implements AgentActorResolver
{
    public function __construct(
        private ?ResolvedAgentActor $actor,
        private bool $mayRead,
    ) {
    }

    public function resolve(string $userUuid): ?ResolvedAgentActor
    {
        return $this->actor;
    }

    public function mayReadPatients(ResolvedAgentActor $actor): bool
    {
        return $this->mayRead;
    }
}
