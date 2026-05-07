<?php

/**
 * Isolated tests for {@see AllergyListWriteService}, the
 * `?type=allergy` branch of {@see PromoteController}, and the
 * {@see AllergyPromotionRequestParser}. The service uses an in-memory
 * {@see AllergyListsTableWriter} so the unit boundary stays free of
 * DBAL.
 *
 * Mirrors the structural layout of `ObservationLabWriteServiceTest`:
 * service-level tests (round-trip, idempotency, error path,
 * DTO-rejects-bad-inputs); controller-level tests (happy path,
 * idempotency through the dispatcher, every error envelope).
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
use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Controller\PromoteController;
use OpenEMR\Modules\ClinicalCopilot\Events\AllergyListEntryCreatedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyListWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicalProblemListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicalProblemPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicalProblemWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationLabWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\PersistedListEntry;
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
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PersistedListEntry.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyPromotionRequest.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/FamilyHistoryListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicalProblemPromotionRequest.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicalProblemListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicationStatementPromotionRequest.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicationStatementListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ProcedureReportTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PersistedProcedureReport.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ObservationResult.php';

final class AllergyListWriteServiceTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';
    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';
    public const FIXED_NOW = '2026-05-08T12:00:00+00:00';
    public const FIXED_JTI = 'test-jti-allergy';

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
        require_once self::MODULE_DIR . '/Events/AllergyListEntryCreatedEvent.php';
        require_once self::MODULE_DIR . '/Events/FamilyHistoryListEntryCreatedEvent.php';
        require_once self::MODULE_DIR . '/Events/MedicalProblemListEntryCreatedEvent.php';
        require_once self::MODULE_DIR . '/Events/MedicationStatementListEntryCreatedEvent.php';
        require_once self::MODULE_DIR . '/Service/ObservationResult.php';
        require_once self::MODULE_DIR . '/Service/LabPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/LabPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/PersistedProcedureReport.php';
        require_once self::MODULE_DIR . '/Service/PersistedListEntry.php';
        require_once self::MODULE_DIR . '/Service/ProcedureReportTableWriter.php';
        require_once self::MODULE_DIR . '/Service/AllergyListsTableWriter.php';
        require_once self::MODULE_DIR . '/Service/FamilyHistoryListsTableWriter.php';
        require_once self::MODULE_DIR . '/Service/MedicalProblemListsTableWriter.php';
        require_once self::MODULE_DIR . '/Service/MedicationStatementListsTableWriter.php';
        require_once self::MODULE_DIR . '/Service/ObservationLabWriteService.php';
        require_once self::MODULE_DIR . '/Service/AllergyPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/AllergyPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/AllergyListWriteService.php';
        require_once self::MODULE_DIR . '/Service/FamilyHistoryPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/FamilyHistoryPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/FamilyHistoryWriteService.php';
        require_once self::MODULE_DIR . '/Service/MedicalProblemPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/MedicalProblemPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/MedicalProblemWriteService.php';
        require_once self::MODULE_DIR . '/Service/MedicationStatementPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/MedicationStatementPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/MedicationStatementWriteService.php';
        require_once self::MODULE_DIR . '/Controller/LabPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/AllergyPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/FamilyHistoryPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/MedicalProblemPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/MedicationStatementPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/PromoteController.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    // ------------------------------------------------------------------
    // Service-level tests — round-trip, idempotency, error path, DTO
    // ------------------------------------------------------------------

    public function testWritePersistsAllergyAndDispatchesEvent(): void
    {
        $writer = new InMemoryAllergyTableWriter();
        $events = new AllergyRecordingEventDispatcher();
        $service = $this->makeService($writer, $events);

        $request = $this->buildRequest();
        $result = $service->write($request);

        $this->assertFalse($result->idempotentHit);
        $this->assertSame(InMemoryAllergyTableWriter::LIST_UUID, $result->listUuid);

        $this->assertCount(1, $writer->insertedAllergies);
        $persisted = $writer->insertedAllergies[0];
        $this->assertSame(4242, $persisted->pid);
        $this->assertSame('penicillin', $persisted->substance);
        $this->assertSame('rash', $persisted->reactionOptionId);
        $this->assertSame('confirmed', $persisted->verificationOptionId);
        $this->assertSame('moderate', $persisted->severity);

        $this->assertCount(1, $events->dispatched);
        $event = $events->dispatched[0];
        $this->assertInstanceOf(AllergyListEntryCreatedEvent::class, $event);
        $this->assertSame(InMemoryAllergyTableWriter::LIST_UUID, $event->listUuid);
        $this->assertSame(4242, $event->pid);
        $this->assertSame('penicillin', $event->substance);
    }

    public function testWriteIsIdempotentOnReCall(): void
    {
        $writer = new InMemoryAllergyTableWriter();
        $events = new AllergyRecordingEventDispatcher();
        $service = $this->makeService($writer, $events);

        $first = $service->write($this->buildRequest());
        $second = $service->write($this->buildRequest());

        $this->assertFalse($first->idempotentHit);
        $this->assertTrue($second->idempotentHit);
        $this->assertSame($first->listUuid, $second->listUuid);
        $this->assertCount(1, $writer->insertedAllergies, 're-call must not insert again');
        $this->assertCount(1, $events->dispatched, 're-call must not re-fire the event');
    }

    public function testWriteIsIdempotentAcrossCaseAndWhitespaceVariants(): void
    {
        $writer = new InMemoryAllergyTableWriter();
        $service = $this->makeService($writer);

        $service->write($this->buildRequest(substance: 'penicillin'));
        $second = $service->write($this->buildRequest(substance: '  Penicillin  '));

        $this->assertTrue(
            $second->idempotentHit,
            'normalization must collapse case + trim differences',
        );
        $this->assertCount(1, $writer->insertedAllergies);
    }

    public function testWriteWrapsTableWriterFailureAsRuntimeException(): void
    {
        $writer = new InMemoryAllergyTableWriter(failOnInsert: true);
        $service = $this->makeService($writer);

        $this->expectException(\RuntimeException::class);
        $service->write($this->buildRequest());
    }

    public function testDtoRejectsEmptyRequiredFields(): void
    {
        $this->expectException(DomainException::class);
        new AllergyPromotionRequest(
            pid: 4242,
            sourceDocumentUuid: 'doc-1',
            substance: '', // empty — invalid
            reactionOptionId: null,
            verificationOptionId: null,
            severity: null,
            comments: null,
            onsetDate: null,
            promotedByUserId: 7,
        );
    }

    // ------------------------------------------------------------------
    // Controller-level tests — dispatch, type-routing, auth, parsing
    // ------------------------------------------------------------------

    public function testControllerAllergyHappyPath(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_ALLERGY]);
        [$status, $body, $disclosures] = $this->dispatchController($token, 'allergy', $this->validBody());

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame(InMemoryAllergyTableWriter::LIST_UUID, $body['chart_record_uuid']);
        $this->assertSame('list_allergy', $body['chart_record_type']);
        $this->assertFalse($body['idempotent_hit']);

        $this->assertCount(1, $disclosures);
        $this->assertSame('tier3_promotion', $disclosures[0]->action);
        $this->assertSame(['allergy'], $disclosures[0]->categories);
        $this->assertSame(4242, $disclosures[0]->patientPid);
    }

    public function testControllerAllergyIdempotentReCallReturnsSameId(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_ALLERGY]);
        $writer = new InMemoryAllergyTableWriter();

        [$status1, $body1] = $this->dispatchController($token, 'allergy', $this->validBody(), $writer);
        [$status2, $body2] = $this->dispatchController($token, 'allergy', $this->validBody(), $writer);

        $this->assertSame(200, $status1);
        $this->assertSame(200, $status2);
        $this->assertNotNull($body1);
        $this->assertNotNull($body2);
        $this->assertSame($body1['chart_record_uuid'], $body2['chart_record_uuid']);
        $this->assertFalse($body1['idempotent_hit']);
        $this->assertTrue($body2['idempotent_hit']);
    }

    public function testControllerAllergyRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatchController($token, 'allergy', $this->validBody());

        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testControllerAllergyRejectsMissingBearer(): void
    {
        [$status, $body] = $this->dispatchController(null, 'allergy', $this->validBody());

        $this->assertSame(401, $status);
        $this->assertSame(['error' => 'missing_token'], $body);
    }

    public function testControllerAllergyRejectsMissingBody(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_ALLERGY]);
        [$status, $body] = $this->dispatchController($token, 'allergy', null);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $body);
    }

    public function testControllerAllergyRejectsMalformedBody(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_ALLERGY]);
        // Missing required `substance`.
        $body = $this->validBody();
        unset($body['substance']);
        [$status, $decoded] = $this->dispatchController($token, 'allergy', $body);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $decoded);
    }

    public function testControllerAllergyWrapsServiceFailureAs503(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_ALLERGY]);
        $writer = new InMemoryAllergyTableWriter(failOnInsert: true);
        [$status, $body] = $this->dispatchController($token, 'allergy', $this->validBody(), $writer);

        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'write_unavailable'], $body);
    }

    public function testControllerLabScopeCannotPromoteAllergy(): void
    {
        // An over-broadly minted lab token (with `user/DiagnosticReport.cs` only)
        // must not be able to write an allergy. The dispatchAllergy branch
        // demands SCOPE_ALLERGY explicitly.
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        [$status, $body] = $this->dispatchController($token, 'allergy', $this->validBody());

        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private function buildRequest(string $substance = 'penicillin'): AllergyPromotionRequest
    {
        return new AllergyPromotionRequest(
            pid: 4242,
            sourceDocumentUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            substance: $substance,
            reactionOptionId: 'rash',
            verificationOptionId: 'confirmed',
            severity: 'moderate',
            comments: 'rash within 30 minutes',
            onsetDate: '2014-06-01',
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
            'substance' => 'penicillin',
            'reaction_option_id' => 'rash',
            'verification_option_id' => 'confirmed',
            'severity' => 'moderate',
            'comments' => 'rash within 30 minutes',
            'onset_date' => '2014-06-01',
        ];
    }

    private function makeService(
        InMemoryAllergyTableWriter $writer,
        ?AllergyRecordingEventDispatcher $events = null,
    ): AllergyListWriteService {
        return new AllergyListWriteService(
            tableWriter: $writer,
            eventDispatcher: $events ?? new AllergyRecordingEventDispatcher(),
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
        ?InMemoryAllergyTableWriter $writer = null,
    ): array {
        $logger = new NullLogger();
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new AllergyStubResolver(
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

        $allergyService = $this->makeService($writer ?? new InMemoryAllergyTableWriter(), null);

        // Lab + medical-problem + medication-statement + family-history
        // services are required by the controller's constructor but not
        // exercised by any allergy test path. No-op writers satisfy the
        // types without any setup cost.
        $labService = new ObservationLabWriteService(
            tableWriter: new NoopProcedureReportTableWriter(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $medicalProblemService = new MedicalProblemWriteService(
            tableWriter: new AllergyTestNoopMedicalProblemTableWriter(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $medicationService = new \OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementWriteService(
            tableWriter: new NoopMedicationStatementTableWriter(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $familyHistoryService = new FamilyHistoryWriteService(
            tableWriter: new NoopFamilyHistoryListsTableWriter(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );

        $controller = new PromoteController(
            auth: $auth,
            labWriteService: $labService,
            allergyWriteService: $allergyService,
            medicalProblemWriteService: $medicalProblemService,
            medicationStatementWriteService: $medicationService,
            familyHistoryWriteService: $familyHistoryService,
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
        return new AllergyFixedClock(new DateTimeImmutable(self::FIXED_NOW));
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
            new AllergyFixedJti(self::FIXED_JTI),
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

final class InMemoryAllergyTableWriter implements AllergyListsTableWriter
{
    public const LIST_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';

    /** @var list<AllergyPromotionRequest> */
    public array $insertedAllergies = [];

    public function __construct(private readonly bool $failOnInsert = false)
    {
    }

    public function findExistingAllergy(
        string $sourceDocumentUuid,
        string $normalizedSubstance,
    ): ?PersistedListEntry {
        foreach ($this->insertedAllergies as $idx => $req) {
            if (
                $req->sourceDocumentUuid === $sourceDocumentUuid
                && $req->normalizedSubstance() === $normalizedSubstance
            ) {
                return new PersistedListEntry(
                    listUuid: self::LIST_UUID,
                    listRowId: $idx + 1,
                );
            }
        }
        return null;
    }

    public function insertAllergy(
        AllergyPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        if ($this->failOnInsert) {
            throw new \RuntimeException('simulated DBAL failure');
        }
        $idx = count($this->insertedAllergies);
        $this->insertedAllergies[] = $request;
        return new PersistedListEntry(
            listUuid: self::LIST_UUID,
            listRowId: $idx + 1,
        );
    }
}

/**
 * No-op medication-statement writer for the allergy controller tests.
 * The controller's constructor needs the medication service for type
 * signature but no allergy test routes through the medication branch.
 */
final class NoopMedicationStatementTableWriter implements \OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementListsTableWriter
{
    public function findExistingMedication(
        string $sourceDocumentUuid,
        string $normalizedDrugName,
    ): ?PersistedListEntry {
        return null;
    }

    public function insertMedication(
        \OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        throw new \RuntimeException('NoopMedicationStatementTableWriter.insertMedication must not be called');
    }
}

/**
 * No-op family-history writer for the allergy controller tests. The
 * controller's constructor needs the family-history service for type
 * signature but no allergy test routes through the family-history
 * branch.
 */
final class NoopFamilyHistoryListsTableWriter implements FamilyHistoryListsTableWriter
{
    public function findExistingFamilyHistory(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry {
        return null;
    }

    public function insertFamilyHistory(
        FamilyHistoryPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        throw new \RuntimeException(
            'NoopFamilyHistoryListsTableWriter.insertFamilyHistory must not be called',
        );
    }
}

/**
 * No-op procedure-report writer for the allergy controller tests. The
 * controller's constructor needs the lab service for type signature
 * but no allergy test routes through the lab branch.
 */
final class NoopProcedureReportTableWriter implements ProcedureReportTableWriter
{
    public function findExistingPanel(
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
    ): ?\OpenEMR\Modules\ClinicalCopilot\Service\PersistedProcedureReport {
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
    ): \OpenEMR\Modules\ClinicalCopilot\Service\PersistedProcedureReport {
        throw new \RuntimeException('NoopProcedureReportTableWriter.insertPanel must not be called');
    }
}

/**
 * No-op medical-problem writer for the allergy controller tests. The
 * controller's constructor needs the medical-problem service for type
 * signature but no allergy test routes through the medical-problem
 * branch.
 */
final class AllergyTestNoopMedicalProblemTableWriter implements MedicalProblemListsTableWriter
{
    public function findExistingMedicalProblem(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry {
        return null;
    }

    public function insertMedicalProblem(
        MedicalProblemPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        throw new \RuntimeException(
            'AllergyTestNoopMedicalProblemTableWriter.insertMedicalProblem must not be called',
        );
    }
}

final class AllergyRecordingEventDispatcher implements \Symfony\Component\EventDispatcher\EventDispatcherInterface
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

final readonly class AllergyFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class AllergyFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class AllergyStubResolver implements \OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver
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
