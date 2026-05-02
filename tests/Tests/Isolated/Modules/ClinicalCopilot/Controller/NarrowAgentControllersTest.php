<?php

/**
 * Isolated tests for the four narrow agent controllers
 * (medications, labs, encounters, patientContext).
 *
 * Each narrow endpoint maps 1:1 to one tool on the agent side and
 * runs only the adapters it needs. The four controllers share
 * authorization (`AgentEndpointAuth`) and disclosure-event shape, so
 * one test file exercises the full surface with parameterized
 * scenarios per endpoint.
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
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Controller\EncountersController;
use OpenEMR\Modules\ClinicalCopilot\Controller\LabHistoryController;
use OpenEMR\Modules\ClinicalCopilot\Controller\LabsController;
use OpenEMR\Modules\ClinicalCopilot\Controller\MedicationsController;
use OpenEMR\Modules\ClinicalCopilot\Controller\PatientContextController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\ArchetypeChartFactory;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryAllergyDataSource;
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

final class NarrowAgentControllersTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';
    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';
    public const FIXED_NOW = '2026-04-30T12:00:00+00:00';
    public const FIXED_JTI = 'test-jti-narrow';

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
            'AuthorizedAgentRequest.php',
            'AgentEndpointAuth.php',
        ] as $f) {
            require_once $auth . '/' . $f;
        }
        require_once self::MODULE_DIR . '/Controller/MedicationsController.php';
        require_once self::MODULE_DIR . '/Controller/LabsController.php';
        require_once self::MODULE_DIR . '/Controller/LabHistoryController.php';
        require_once self::MODULE_DIR . '/Controller/EncountersController.php';
        require_once self::MODULE_DIR . '/Controller/PatientContextController.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    // ------------------------------------------------------------------
    // Medications endpoint
    // ------------------------------------------------------------------

    public function testMedicationsHappyPathReturnsActiveMeds(): void
    {
        $token = $this->mintToken(['user/MedicationRequest.rs']);
        [$status, $body, $events] = $this->dispatchMedications($token, 4242);

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertArrayHasKey('medications', $body);
        $this->assertIsArray($body['medications']);
        $this->assertNotEmpty($body['medications']);
        $this->assertCount(1, $events);
        $this->assertSame('medications', $events[0]->action);
        $this->assertSame(['medication'], $events[0]->categories);
    }

    public function testMedicationsRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatchMedications($token, 4242);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testMedicationsRejectsMissingToken(): void
    {
        [$status, $body] = $this->dispatchMedications(null, 4242);
        $this->assertSame(401, $status);
        $this->assertSame(['error' => 'missing_token'], $body);
    }

    public function testMedicationsRejectsMissingPid(): void
    {
        $token = $this->mintToken(['user/MedicationRequest.rs']);
        [$status, $body] = $this->dispatchMedications($token, null);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_pid'], $body);
    }

    // ------------------------------------------------------------------
    // Labs endpoint
    // ------------------------------------------------------------------

    public function testLabsHappyPathReturnsRecentLabs(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body, $events] = $this->dispatchLabs($token, 4242);

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertArrayHasKey('labs', $body);
        $this->assertIsArray($body['labs']);
        $this->assertCount(1, $events);
        $this->assertSame('labs', $events[0]->action);
        $this->assertSame(['lab'], $events[0]->categories);
    }

    public function testLabsRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/MedicationRequest.rs']);
        [$status, $body] = $this->dispatchLabs($token, 4242);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    // ------------------------------------------------------------------
    // Lab-history endpoint (UC2 trend)
    // ------------------------------------------------------------------

    public function testLabHistoryHappyPathReturnsAnalyteSeries(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body, $events] = $this->dispatchLabHistory(
            $token,
            4242,
            'Hemoglobin A1c',
            730,
        );

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertArrayHasKey('labs', $body);
        $this->assertIsArray($body['labs']);
        $this->assertCount(1, $events);
        $this->assertSame('lab-history', $events[0]->action);
        $this->assertSame(['lab'], $events[0]->categories);
    }

    public function testLabHistoryRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/MedicationRequest.rs']);
        [$status, $body] = $this->dispatchLabHistory($token, 4242, 'A1c', 365);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testLabHistoryRejectsMissingPid(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body] = $this->dispatchLabHistory($token, null, 'A1c', 365);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'missing_pid'], $body);
    }

    public function testLabHistoryRejectsMissingAnalyte(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body] = $this->dispatchLabHistory($token, 4242, null, 365);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_analyte'], $body);
    }

    public function testLabHistoryRejectsEmptyAnalyte(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body] = $this->dispatchLabHistory($token, 4242, '', 365);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_analyte'], $body);
    }

    public function testLabHistoryRejectsNonPositiveLookback(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body] = $this->dispatchLabHistory($token, 4242, 'A1c', 0);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_lookback_days'], $body);
    }

    public function testLabHistoryRejectsExcessiveLookback(): void
    {
        $token = $this->mintToken(['user/Observation.rs']);
        [$status, $body] = $this->dispatchLabHistory($token, 4242, 'A1c', 999_999);
        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_lookback_days'], $body);
    }

    // ------------------------------------------------------------------
    // Encounters endpoint
    // ------------------------------------------------------------------

    public function testEncountersHappyPathReturnsRecentEncounters(): void
    {
        $token = $this->mintToken(['user/Encounter.rs']);
        [$status, $body, $events] = $this->dispatchEncounters($token, 4242);

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertArrayHasKey('encounters', $body);
        $this->assertIsArray($body['encounters']);
        $this->assertCount(1, $events);
        $this->assertSame('encounters', $events[0]->action);
        $this->assertSame(['encounter'], $events[0]->categories);
    }

    public function testEncountersRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatchEncounters($token, 4242);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    // ------------------------------------------------------------------
    // PatientContext endpoint
    // ------------------------------------------------------------------

    public function testPatientContextHappyPathReturnsBundle(): void
    {
        $token = $this->mintToken(['user/Condition.rs', 'user/AllergyIntolerance.rs']);
        [$status, $body, $events] = $this->dispatchPatientContext($token, 4242);

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertArrayHasKey('patient', $body);
        $this->assertArrayHasKey('diagnoses', $body);
        $this->assertArrayHasKey('allergies', $body);
        $this->assertCount(1, $events);
        $this->assertSame('patient_context', $events[0]->action);
        // categories sorted alphabetically by AgentDisclosure
        $this->assertSame(['allergy', 'diagnosis'], $events[0]->categories);
    }

    public function testPatientContextRejectsTokenLackingConditionScope(): void
    {
        $token = $this->mintToken(['user/AllergyIntolerance.rs']);
        [$status, $body] = $this->dispatchPatientContext($token, 4242);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testPatientContextRejectsTokenLackingAllergyScope(): void
    {
        $token = $this->mintToken(['user/Condition.rs']);
        [$status, $body] = $this->dispatchPatientContext($token, 4242);
        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    // ------------------------------------------------------------------
    // Dispatch helpers
    // ------------------------------------------------------------------

    /** @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>} */
    private function dispatchMedications(?string $token, ?int $pid): array
    {
        $chart = $this->chart();
        return $this->dispatchWith(static fn($auth, $dispatcher, $logger) => new MedicationsController(
            auth: $auth,
            medicationAdapter: new MedicationAdapter(new InMemoryMedicationDataSource($chart)),
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: self::staticFixedClock(),
        ), $token, $pid);
    }

    /** @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>} */
    private function dispatchLabs(?string $token, ?int $pid): array
    {
        $chart = $this->chart();
        return $this->dispatchWith(static fn($auth, $dispatcher, $logger) => new LabsController(
            auth: $auth,
            observationAdapter: new ObservationAdapter(new InMemoryObservationDataSource($chart)),
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: self::staticFixedClock(),
        ), $token, $pid);
    }

    /** @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>} */
    private function dispatchLabHistory(
        ?string $token,
        ?int $pid,
        ?string $analyte,
        ?int $lookbackDays,
    ): array {
        $chart = $this->chart();
        $controllerFactory = static fn(
            AgentEndpointAuth $auth,
            EventDispatcher $dispatcher,
            NullLogger $logger,
        ): LabHistoryController => new LabHistoryController(
            auth: $auth,
            observationAdapter: new ObservationAdapter(new InMemoryObservationDataSource($chart)),
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: self::staticFixedClock(),
        );
        return $this->dispatchLabHistoryWith($controllerFactory, $token, $pid, $analyte, $lookbackDays);
    }

    /**
     * LabHistory's `handle()` takes two extra args (analyte, lookback)
     * beyond the `(token, pid, conversation)` shape the other narrow
     * controllers share. Keep the rest of the dispatch (auth wiring,
     * event-dispatcher pipeline, output capture) identical to
     * {@see dispatchWith}.
     *
     * @param callable(AgentEndpointAuth, EventDispatcher, NullLogger): LabHistoryController $factory
     * @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>}
     */
    private function dispatchLabHistoryWith(
        callable $factory,
        ?string $token,
        ?int $pid,
        ?string $analyte,
        ?int $lookbackDays,
    ): array {
        $logger = new NullLogger();

        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new NarrowControllerStubResolver(
            new ResolvedAgentActor(7, 'patel', $this->actorUuid()),
            true,
        );

        $auth = new AgentEndpointAuth(
            new OpenEmrJwtVerifier(
                publicKeyPem: self::keypair()['public'],
                issuer: self::ISSUER,
                audience: AgentTokenMinter::AGENT_CLIENT_ID,
                clock: $this->fixedClock(),
            ),
            $resolver,
            $logger,
            'default',
        );

        $controller = $factory($auth, $dispatcher, $logger);

        ob_start();
        try {
            $controller->handle($token, $pid, null, $analyte, $lookbackDays);
        } finally {
            $output = ob_get_clean();
        }

        $status = http_response_code();
        $this->assertIsInt($status);

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

    /** @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>} */
    private function dispatchEncounters(?string $token, ?int $pid): array
    {
        $chart = $this->chart();
        return $this->dispatchWith(static fn($auth, $dispatcher, $logger) => new EncountersController(
            auth: $auth,
            encounterAdapter: new EncounterAdapter(new InMemoryEncounterDataSource($chart)),
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: self::staticFixedClock(),
        ), $token, $pid);
    }

    /** @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>} */
    private function dispatchPatientContext(?string $token, ?int $pid): array
    {
        $chart = $this->chart();
        return $this->dispatchWith(static fn($auth, $dispatcher, $logger) => new PatientContextController(
            auth: $auth,
            patientAdapter: new PatientAdapter(new InMemoryPatientDataSource($chart)),
            conditionAdapter: new ConditionAdapter(new InMemoryConditionDataSource($chart)),
            allergyAdapter: new AllergyAdapter(new InMemoryAllergyDataSource($chart)),
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: self::staticFixedClock(),
        ), $token, $pid);
    }

    /**
     * Common runner: build the disclosure pipeline, hand the controller
     * factory the auth helper, dispatch, capture output + events. The
     * four narrow controllers share the same `handle()` shape so they
     * are interchangeable here.
     *
     * @param callable(AgentEndpointAuth, EventDispatcher, NullLogger): (MedicationsController|LabsController|EncountersController|PatientContextController) $factory
     * @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>}
     */
    private function dispatchWith(callable $factory, ?string $token, ?int $pid): array
    {
        $logger = new NullLogger();

        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new NarrowControllerStubResolver(
            new ResolvedAgentActor(7, 'patel', $this->actorUuid()),
            true,
        );

        $auth = new AgentEndpointAuth(
            new OpenEmrJwtVerifier(
                publicKeyPem: self::keypair()['public'],
                issuer: self::ISSUER,
                audience: AgentTokenMinter::AGENT_CLIENT_ID,
                clock: $this->fixedClock(),
            ),
            $resolver,
            $logger,
            'default',
        );

        $controller = $factory($auth, $dispatcher, $logger);

        ob_start();
        try {
            $controller->handle($token, $pid, null);
        } finally {
            $output = ob_get_clean();
        }

        $status = http_response_code();
        $this->assertIsInt($status);

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

    private function chart(): \OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\ArchetypeChart
    {
        return (new ArchetypeChartFactory(20260430))->build(PatientArchetype::Diabetic, pid: 4242);
    }

    private function fixedClock(): ClockInterface
    {
        return self::staticFixedClock();
    }

    private static function staticFixedClock(): ClockInterface
    {
        return new NarrowControllerFixedClock(new DateTimeImmutable(self::FIXED_NOW));
    }

    private function fixedJti(): JtiGenerator
    {
        return new NarrowControllerFixedJti(self::FIXED_JTI);
    }

    private function actorUuid(): string
    {
        return 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';
    }

    /** @param list<string> $scopes */
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

    /** @return array{private: string, public: string} */
    private static function keypair(): array
    {
        if (self::$keypair === null) {
            self::fail('keypair not initialized');
        }
        return self::$keypair;
    }

    /** @return array{private: string, public: string} */
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

final readonly class NarrowControllerFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class NarrowControllerFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class NarrowControllerStubResolver implements \OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver
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
