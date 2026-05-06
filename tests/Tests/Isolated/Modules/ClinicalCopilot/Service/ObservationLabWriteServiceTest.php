<?php

/**
 * Isolated tests for {@see ObservationLabWriteService}, the
 * {@see PromoteController} dispatcher, and the parser. The service
 * uses an in-memory {@see ProcedureReportTableWriter} so the unit
 * boundary stays free of DBAL.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Service;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Controller\PromoteController;
use OpenEMR\Modules\ClinicalCopilot\Events\ProcedureReportCreatedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Service\LabPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationLabWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationResult;
use OpenEMR\Modules\ClinicalCopilot\Service\PersistedProcedureReport;
use OpenEMR\Modules\ClinicalCopilot\Service\ProcedureReportTableWriter;
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
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ObservationResult.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PersistedProcedureReport.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ProcedureReportTableWriter.php';

final class ObservationLabWriteServiceTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';
    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';
    public const FIXED_NOW = '2026-05-05T12:00:00+00:00';
    public const FIXED_JTI = 'test-jti-promote';

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

        require_once self::MODULE_DIR . '/Events/ProcedureReportCreatedEvent.php';
        require_once self::MODULE_DIR . '/Service/ObservationResult.php';
        require_once self::MODULE_DIR . '/Service/LabPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/LabPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/PersistedProcedureReport.php';
        require_once self::MODULE_DIR . '/Service/ProcedureReportTableWriter.php';
        require_once self::MODULE_DIR . '/Service/ObservationLabWriteService.php';
        require_once self::MODULE_DIR . '/Controller/LabPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/PromoteController.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    // ------------------------------------------------------------------
    // Service-level tests — round-trip, idempotency, error path
    // ------------------------------------------------------------------

    public function testWritePersistsPanelAndDispatchesEvent(): void
    {
        $writer = new InMemoryProcedureReportTableWriter();
        $events = new PromoteRecordingEventDispatcher();
        $service = $this->makeService($writer, $events);

        $request = $this->buildRequest();
        $result = $service->write($request);

        $this->assertFalse($result->idempotentHit);
        $this->assertCount(2, $result->observationUuids);
        $this->assertSame(InMemoryProcedureReportTableWriter::REPORT_UUID, $result->diagnosticReportUuid);

        $this->assertCount(1, $writer->insertedPanels);
        $panel = $writer->insertedPanels[0];
        $this->assertSame(4242, $panel['pid']);
        $this->assertSame('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', $panel['sourceDocumentUuid']);
        $this->assertSame('57021-8', $panel['panelCode']);
        $this->assertSame('2026-04-15', $panel['collectionDate']);
        $this->assertSame(7, $panel['promotedByUserId']);
        $this->assertCount(2, $panel['results']);

        $first = $panel['results'][0];
        $this->assertSame('Hemoglobin A1c', $first->analyteName);
        $this->assertSame('5.7', $first->value);
        $this->assertSame('%', $first->unit);
        $this->assertSame('4.0', $first->refRangeLow);
        $this->assertSame('5.6', $first->refRangeHigh);
        $this->assertSame('high', $first->abnormalFlag);

        $this->assertCount(1, $events->dispatched);
        $event = $events->dispatched[0];
        $this->assertInstanceOf(ProcedureReportCreatedEvent::class, $event);
        $this->assertSame(InMemoryProcedureReportTableWriter::REPORT_UUID, $event->procedureReportUuid);
        $this->assertSame(4242, $event->pid);
        $this->assertSame('57021-8', $event->panelCode);
        $this->assertSame('2026-04-15', $event->collectionDate);
        $this->assertCount(2, $event->observationUuids);
    }

    public function testWriteIsIdempotentOnReCall(): void
    {
        $writer = new InMemoryProcedureReportTableWriter();
        $events = new PromoteRecordingEventDispatcher();
        $service = $this->makeService($writer, $events);

        $first = $service->write($this->buildRequest());
        $second = $service->write($this->buildRequest());

        $this->assertFalse($first->idempotentHit);
        $this->assertTrue($second->idempotentHit);
        $this->assertSame($first->diagnosticReportUuid, $second->diagnosticReportUuid);
        $this->assertSame($first->observationUuids, $second->observationUuids);
        $this->assertCount(1, $writer->insertedPanels, 're-call must not insert a second panel');
        $this->assertCount(1, $events->dispatched, 're-call must not re-fire the event');
    }

    public function testWriteWrapsTableWriterFailureAsRuntimeException(): void
    {
        $writer = new InMemoryProcedureReportTableWriter(failOnInsert: true);
        $service = $this->makeService($writer);

        $this->expectException(\RuntimeException::class);
        $service->write($this->buildRequest());
    }

    public function testObservationResultRejectsInvalidAbnormalFlag(): void
    {
        $this->expectException(\DomainException::class);
        new ObservationResult(
            analyteName: 'A1c',
            value: '5.7',
            unit: '%',
            refRangeLow: null,
            refRangeHigh: null,
            abnormalFlag: 'mild', // not in the allowed set
        );
    }

    // ------------------------------------------------------------------
    // Controller-level tests — dispatch, type-routing, auth, parsing
    // ------------------------------------------------------------------

    public function testControllerLabHappyPath(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        [$status, $body, $disclosures] = $this->dispatchController($token, 'lab', $this->validBody());

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame(InMemoryProcedureReportTableWriter::REPORT_UUID, $body['chart_record_uuid']);
        $this->assertSame('diagnostic_report', $body['chart_record_type']);
        $this->assertIsArray($body['observation_uuids']);
        $this->assertCount(2, $body['observation_uuids']);
        $this->assertFalse($body['idempotent_hit']);

        $this->assertCount(1, $disclosures);
        $this->assertSame('tier3_promotion', $disclosures[0]->action);
        $this->assertSame(['lab'], $disclosures[0]->categories);
        $this->assertSame(4242, $disclosures[0]->patientPid);
    }

    public function testControllerIdempotentReCallReturnsSameIds(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        $writer = new InMemoryProcedureReportTableWriter();

        [$status1, $body1] = $this->dispatchController($token, 'lab', $this->validBody(), $writer);
        [$status2, $body2] = $this->dispatchController($token, 'lab', $this->validBody(), $writer);

        $this->assertSame(200, $status1);
        $this->assertSame(200, $status2);
        $this->assertNotNull($body1);
        $this->assertNotNull($body2);
        $this->assertSame($body1['chart_record_uuid'], $body2['chart_record_uuid']);
        $this->assertFalse($body1['idempotent_hit']);
        $this->assertTrue($body2['idempotent_hit']);
    }

    public function testControllerRejectsMissingType(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        [$status, $body] = $this->dispatchController($token, null, $this->validBody());

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_type'], $body);
    }

    public function testControllerRejectsUnknownType(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        [$status, $body] = $this->dispatchController($token, 'mystery', $this->validBody());

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_type'], $body);
    }

    public function testControllerReturnsNotImplementedForFutureTypes(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        foreach (
            ['allergy', 'medication_statement', 'past_medical_history', 'family_history', 'demographics']
            as $type
        ) {
            [$status, $body] = $this->dispatchController($token, $type, $this->validBody());
            $this->assertSame(501, $status, "type=$type should be 501");
            $this->assertSame(['error' => 'not_yet_implemented'], $body);
        }
    }

    public function testControllerRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatchController($token, 'lab', $this->validBody());

        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testControllerRejectsMissingBearer(): void
    {
        [$status, $body] = $this->dispatchController(null, 'lab', $this->validBody());

        $this->assertSame(401, $status);
        $this->assertSame(['error' => 'missing_token'], $body);
    }

    public function testControllerRejectsMissingBody(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        [$status, $body] = $this->dispatchController($token, 'lab', null);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $body);
    }

    public function testControllerRejectsMalformedBody(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        // Missing required `pid`.
        $body = $this->validBody();
        unset($body['pid']);
        [$status, $decoded] = $this->dispatchController($token, 'lab', $body);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $decoded);
    }

    public function testControllerRejectsBodyWithEmptyResults(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        $body = $this->validBody();
        $body['results'] = [];
        [$status, $decoded] = $this->dispatchController($token, 'lab', $body);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $decoded);
    }

    public function testControllerWrapsServiceFailureAs503(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        $writer = new InMemoryProcedureReportTableWriter(failOnInsert: true);
        [$status, $body] = $this->dispatchController($token, 'lab', $this->validBody(), $writer);

        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'write_unavailable'], $body);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private function buildRequest(): LabPromotionRequest
    {
        return new LabPromotionRequest(
            pid: 4242,
            sourceDocumentUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            panelCode: '57021-8',
            collectionDate: '2026-04-15',
            results: [
                new ObservationResult(
                    analyteName: 'Hemoglobin A1c',
                    value: '5.7',
                    unit: '%',
                    refRangeLow: '4.0',
                    refRangeHigh: '5.6',
                    abnormalFlag: 'high',
                ),
                new ObservationResult(
                    analyteName: 'Glucose',
                    value: '102',
                    unit: 'mg/dL',
                    refRangeLow: '70',
                    refRangeHigh: '99',
                    abnormalFlag: 'high',
                ),
            ],
            promotedByUserId: 7,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function validBody(): array
    {
        return [
            'pid' => 4242,
            'source_document_uuid' => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            'panel_code' => '57021-8',
            'collection_date' => '2026-04-15',
            'results' => [
                [
                    'analyte_name' => 'Hemoglobin A1c',
                    'value' => '5.7',
                    'unit' => '%',
                    'ref_range_low' => '4.0',
                    'ref_range_high' => '5.6',
                    'abnormal_flag' => 'high',
                ],
                [
                    'analyte_name' => 'Glucose',
                    'value' => '102',
                    'unit' => 'mg/dL',
                    'ref_range_low' => '70',
                    'ref_range_high' => '99',
                    'abnormal_flag' => 'high',
                ],
            ],
        ];
    }

    private function makeService(
        InMemoryProcedureReportTableWriter $writer,
        ?PromoteRecordingEventDispatcher $events = null,
    ): ObservationLabWriteService {
        return new ObservationLabWriteService(
            tableWriter: $writer,
            eventDispatcher: $events ?? new PromoteRecordingEventDispatcher(),
            clock: $this->fixedClock(),
            logger: new NullLogger(),
        );
    }

    /**
     * @param array<string, mixed>|null $body
     * @return array{0: int, 1: ?array<string, mixed>, 2: list<\OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure>}
     */
    private function dispatchController(
        ?string $token,
        ?string $type,
        ?array $body,
        ?InMemoryProcedureReportTableWriter $writer = null,
    ): array {
        $logger = new NullLogger();
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new PromoteStubResolver(
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

        $service = $this->makeService($writer ?? new InMemoryProcedureReportTableWriter());

        $controller = new PromoteController(
            auth: $auth,
            labWriteService: $service,
            eventDispatcher: $dispatcher,
            logger: $logger,
            siteId: 'default',
            clock: $this->fixedClock(),
        );

        ob_start();
        try {
            $controller->dispatch($token, $type, $body, null);
        } finally {
            $output = ob_get_clean();
        }

        $status = http_response_code();
        $this->assertIsInt($status);

        $decoded = null;
        if ($output !== '' && $output !== false) {
            $raw = json_decode($output, true);
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
        return new PromoteFixedClock(new DateTimeImmutable(self::FIXED_NOW));
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
            new PromoteFixedJti(self::FIXED_JTI),
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

/**
 * @phpstan-type InsertedPanelRecord array{
 *     pid: int,
 *     sourceDocumentUuid: string,
 *     panelCode: ?string,
 *     collectionDate: string,
 *     results: non-empty-list<ObservationResult>,
 *     promotedByUserId: int
 * }
 */
final class InMemoryProcedureReportTableWriter implements ProcedureReportTableWriter
{
    public const REPORT_UUID = 'cccccccc-1111-2222-3333-444444444444';

    /** @var list<InsertedPanelRecord> */
    public array $insertedPanels = [];

    public function __construct(private readonly bool $failOnInsert = false)
    {
    }

    public function findExistingPanel(
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
    ): ?PersistedProcedureReport {
        foreach ($this->insertedPanels as $idx => $panel) {
            if (
                $panel['sourceDocumentUuid'] === $sourceDocumentUuid
                && $panel['panelCode'] === $panelCode
                && $panel['collectionDate'] === $collectionDate
            ) {
                $obsUuids = self::observationUuidsFor($idx, count($panel['results']));
                return new PersistedProcedureReport(
                    procedureReportUuid: self::REPORT_UUID,
                    procedureReportRowId: $idx + 1,
                    observationUuids: $obsUuids,
                );
            }
        }
        return null;
    }

    public function insertPanel(
        int $pid,
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
        array $results,
        int $promotedByUserId,
        \DateTimeImmutable $createdAt,
    ): PersistedProcedureReport {
        if ($this->failOnInsert) {
            throw new \RuntimeException('simulated DBAL failure');
        }
        $idx = count($this->insertedPanels);
        $this->insertedPanels[] = [
            'pid' => $pid,
            'sourceDocumentUuid' => $sourceDocumentUuid,
            'panelCode' => $panelCode,
            'collectionDate' => $collectionDate,
            'results' => $results,
            'promotedByUserId' => $promotedByUserId,
        ];
        return new PersistedProcedureReport(
            procedureReportUuid: self::REPORT_UUID,
            procedureReportRowId: $idx + 1,
            observationUuids: self::observationUuidsFor($idx, count($results)),
        );
    }

    /** @return non-empty-list<string> */
    private static function observationUuidsFor(int $panelIdx, int $count): array
    {
        if ($count <= 0) {
            throw new \RuntimeException('observationUuidsFor count must be positive');
        }
        /** @var non-empty-list<string> $uuids */
        $uuids = [];
        for ($i = 0; $i < $count; $i++) {
            $uuids[] = sprintf('dddddddd-%04d-%04d-0000-000000000000', $panelIdx, $i);
        }
        return $uuids;
    }
}

final class PromoteRecordingEventDispatcher implements \Symfony\Component\EventDispatcher\EventDispatcherInterface
{
    /** @var list<object> */
    public array $dispatched = [];

    public function dispatch(object $event, ?string $eventName = null): object
    {
        $this->dispatched[] = $event;
        return $event;
    }

    public function addListener(string $eventName, callable $listener, int $priority = 0): void
    {
    }

    public function addSubscriber(\Symfony\Component\EventDispatcher\EventSubscriberInterface $subscriber): void
    {
    }

    public function removeListener(string $eventName, callable $listener): void
    {
    }

    public function removeSubscriber(\Symfony\Component\EventDispatcher\EventSubscriberInterface $subscriber): void
    {
    }

    /** @return array<int, array<int, callable>>|array<int, callable> */
    public function getListeners(?string $eventName = null): array
    {
        return [];
    }

    public function getListenerPriority(string $eventName, callable $listener): ?int
    {
        return null;
    }

    public function hasListeners(?string $eventName = null): bool
    {
        return false;
    }
}

final readonly class PromoteFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class PromoteFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class PromoteStubResolver implements \OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver
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
