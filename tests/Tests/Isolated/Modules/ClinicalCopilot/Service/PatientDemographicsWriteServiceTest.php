<?php

/**
 * Isolated tests for {@see PatientDemographicsWriteService}, the
 * `?type=demographics` branch of {@see PromoteController}, and the
 * {@see DemographicsPromotionRequestParser}. The service uses an
 * in-memory {@see PatientDemographicsTableWriter} so the unit
 * boundary stays free of `PatientService::databaseUpdate()` (and
 * thus the `sqlStatement` / `OEGlobalsBag` global surface).
 *
 * Mirrors the structural layout of `AllergyListWriteServiceTest`
 * (the F.5b precedent for inline-controls Tier-3 writes), with
 * shape variations for in-place updates rather than insert-new-row:
 *
 *   - Service-level: round-trip + dispatches event; idempotent
 *     re-call when the chart already matches; missing-patient ⇒
 *     RuntimeException; table-writer failure ⇒ RuntimeException;
 *     DTO rejects empty fields.
 *   - Controller-level: happy path (address/phone/email per
 *     case); idempotent re-call through the dispatcher; cross-scope
 *     rejection (lab token cannot promote demographics); missing /
 *     invalid bearer / scope / body envelopes.
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
use OpenEMR\Modules\ClinicalCopilot\Events\PatientDemographicsUpdatedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyListWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\DemographicsField;
use OpenEMR\Modules\ClinicalCopilot\Service\DemographicsPromotionRequest;
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
use OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsSnapshot;
use OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsWriteService;
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
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/DemographicsField.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PatientDemographicsSnapshot.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PatientDemographicsTableWriter.php';

final class PatientDemographicsWriteServiceTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';
    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';
    public const FIXED_NOW = '2026-05-08T12:00:00+00:00';
    public const FIXED_JTI = 'test-jti-demographics';

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
        require_once self::MODULE_DIR . '/Events/PatientDemographicsUpdatedEvent.php';
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
        require_once self::MODULE_DIR . '/Service/DemographicsField.php';
        require_once self::MODULE_DIR . '/Service/DemographicsPromotionRequest.php';
        require_once self::MODULE_DIR . '/Service/DemographicsPromotionResult.php';
        require_once self::MODULE_DIR . '/Service/PatientDemographicsSnapshot.php';
        require_once self::MODULE_DIR . '/Service/PatientDemographicsTableWriter.php';
        require_once self::MODULE_DIR . '/Service/PatientDemographicsWriteService.php';
        require_once self::MODULE_DIR . '/Controller/LabPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/AllergyPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/FamilyHistoryPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/MedicalProblemPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/MedicationStatementPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/DemographicsPromotionRequestParser.php';
        require_once self::MODULE_DIR . '/Controller/PromoteController.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    // ------------------------------------------------------------------
    // Service-level tests — round-trip, idempotency, error path, DTO
    // ------------------------------------------------------------------

    public function testWriteUpdatesAddressAndDispatchesEvent(): void
    {
        $writer = new InMemoryDemographicsTableWriter([
            4242 => InMemoryDemographicsTableWriter::PATIENT_UUID,
        ]);
        $events = new DemographicsRecordingEventDispatcher();
        $service = $this->makeService($writer, $events);

        $request = $this->buildRequest();
        $result = $service->write($request);

        $this->assertFalse($result->idempotentHit);
        $this->assertSame(InMemoryDemographicsTableWriter::PATIENT_UUID, $result->patientUuid);

        $this->assertCount(1, $writer->updates);
        $update = $writer->updates[0];
        $this->assertSame(4242, $update['pid']);
        $this->assertSame(DemographicsField::Address, $update['field']);
        $this->assertSame('742 Evergreen Terrace, Springfield IL 62701', $update['value']);
        $this->assertSame(7, $update['promotedByUserId']);

        $this->assertCount(1, $events->dispatched);
        $event = $events->dispatched[0];
        $this->assertInstanceOf(PatientDemographicsUpdatedEvent::class, $event);
        $this->assertSame(InMemoryDemographicsTableWriter::PATIENT_UUID, $event->patientUuid);
        $this->assertSame(4242, $event->pid);
        $this->assertSame(DemographicsField::Address, $event->field);
    }

    public function testWriteUpdatesPhone(): void
    {
        $writer = new InMemoryDemographicsTableWriter([
            4242 => InMemoryDemographicsTableWriter::PATIENT_UUID,
        ]);
        $service = $this->makeService($writer);

        $service->write($this->buildRequest(field: DemographicsField::Phone, value: '555-867-5309'));

        $this->assertCount(1, $writer->updates);
        $this->assertSame(DemographicsField::Phone, $writer->updates[0]['field']);
        $this->assertSame('555-867-5309', $writer->updates[0]['value']);
    }

    public function testWriteIsIdempotentWhenChartMatches(): void
    {
        $writer = new InMemoryDemographicsTableWriter(
            [4242 => InMemoryDemographicsTableWriter::PATIENT_UUID],
            [
                4242 => [DemographicsField::Address->value => '742 Evergreen Terrace, Springfield IL 62701'],
            ],
        );
        $events = new DemographicsRecordingEventDispatcher();
        $service = $this->makeService($writer, $events);

        $result = $service->write($this->buildRequest());

        $this->assertTrue($result->idempotentHit);
        $this->assertSame(InMemoryDemographicsTableWriter::PATIENT_UUID, $result->patientUuid);
        $this->assertCount(0, $writer->updates, 'idempotent re-call must not re-write the column');
        $this->assertCount(0, $events->dispatched, 'idempotent re-call must not fire the event');
    }

    public function testWriteRejectsUnknownPatient(): void
    {
        $writer = new InMemoryDemographicsTableWriter([]); // no rows
        $service = $this->makeService($writer);

        $this->expectException(\RuntimeException::class);
        $service->write($this->buildRequest());
    }

    public function testWriteWrapsTableWriterFailureAsRuntimeException(): void
    {
        $writer = new InMemoryDemographicsTableWriter(
            [4242 => InMemoryDemographicsTableWriter::PATIENT_UUID],
            [],
            failOnUpdate: true,
        );
        $service = $this->makeService($writer);

        $this->expectException(\RuntimeException::class);
        $service->write($this->buildRequest());
    }

    public function testDtoRejectsEmptyRequiredFields(): void
    {
        $this->expectException(DomainException::class);
        new DemographicsPromotionRequest(
            pid: 4242,
            sourceDocumentUuid: 'doc-1',
            field: DemographicsField::Address,
            value: '', // empty — invalid
            promotedByUserId: 7,
        );
    }

    public function testDtoRejectsZeroPid(): void
    {
        $this->expectException(DomainException::class);
        new DemographicsPromotionRequest(
            pid: 0,
            sourceDocumentUuid: 'doc-1',
            field: DemographicsField::Address,
            value: '742 Evergreen Terrace',
            promotedByUserId: 7,
        );
    }

    // ------------------------------------------------------------------
    // Controller-level tests — dispatch, type-routing, auth, parsing
    // ------------------------------------------------------------------

    public function testControllerDemographicsHappyPath(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_DEMOGRAPHICS]);
        [$status, $body, $disclosures] = $this->dispatchController(
            $token,
            'demographics',
            $this->validBody(),
        );

        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame(InMemoryDemographicsTableWriter::PATIENT_UUID, $body['chart_record_uuid']);
        $this->assertSame('patient_demographics', $body['chart_record_type']);
        $this->assertFalse($body['idempotent_hit']);

        $this->assertCount(1, $disclosures);
        $this->assertSame('tier3_promotion', $disclosures[0]->action);
        $this->assertSame(['demographics'], $disclosures[0]->categories);
        $this->assertSame(4242, $disclosures[0]->patientPid);
    }

    public function testControllerDemographicsIdempotentReCallReturnsSameIdWithoutSecondDisclosure(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_DEMOGRAPHICS]);
        $writer = new InMemoryDemographicsTableWriter(
            [4242 => InMemoryDemographicsTableWriter::PATIENT_UUID],
        );

        [$status1, $body1, $disclosures1] = $this->dispatchController(
            $token,
            'demographics',
            $this->validBody(),
            $writer,
        );
        [$status2, $body2, $disclosures2] = $this->dispatchController(
            $token,
            'demographics',
            $this->validBody(),
            $writer,
        );

        $this->assertSame(200, $status1);
        $this->assertSame(200, $status2);
        $this->assertNotNull($body1);
        $this->assertNotNull($body2);
        $this->assertSame($body1['chart_record_uuid'], $body2['chart_record_uuid']);
        $this->assertFalse($body1['idempotent_hit']);
        $this->assertTrue($body2['idempotent_hit']);
        // Idempotent re-call is a structural no-op: no second chart
        // write, and no second disclosure event. The second
        // dispatchController() call uses a fresh `$disclosureSink`
        // (in-memory recorder) so an idempotent hit must produce zero
        // disclosures on its own — the audit trail says "the agent
        // disclosed PHI for one Tier-3 promotion," not two.
        $this->assertCount(1, $disclosures1);
        $this->assertCount(0, $disclosures2);
    }

    public function testControllerDemographicsRejectsTokenLackingScope(): void
    {
        $token = $this->mintToken(['user/Patient.rs']);
        [$status, $body] = $this->dispatchController(
            $token,
            'demographics',
            $this->validBody(),
        );

        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    public function testControllerDemographicsRejectsMissingBearer(): void
    {
        [$status, $body] = $this->dispatchController(null, 'demographics', $this->validBody());

        $this->assertSame(401, $status);
        $this->assertSame(['error' => 'missing_token'], $body);
    }

    public function testControllerDemographicsRejectsMissingBody(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_DEMOGRAPHICS]);
        [$status, $body] = $this->dispatchController($token, 'demographics', null);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $body);
    }

    public function testControllerDemographicsRejectsMalformedBody(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_DEMOGRAPHICS]);
        // Missing required `field`.
        $body = $this->validBody();
        unset($body['field']);
        [$status, $decoded] = $this->dispatchController($token, 'demographics', $body);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $decoded);
    }

    public function testControllerDemographicsRejectsUnknownFieldEnum(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_DEMOGRAPHICS]);
        $body = $this->validBody();
        $body['field'] = 'fax'; // not in the closed set
        [$status, $decoded] = $this->dispatchController($token, 'demographics', $body);

        $this->assertSame(400, $status);
        $this->assertSame(['error' => 'invalid_body'], $decoded);
    }

    public function testControllerDemographicsWrapsServiceFailureAs503(): void
    {
        $token = $this->mintToken([PromoteController::SCOPE_DEMOGRAPHICS]);
        $writer = new InMemoryDemographicsTableWriter(
            [4242 => InMemoryDemographicsTableWriter::PATIENT_UUID],
            [],
            failOnUpdate: true,
        );
        [$status, $body] = $this->dispatchController(
            $token,
            'demographics',
            $this->validBody(),
            $writer,
        );

        $this->assertSame(503, $status);
        $this->assertSame(['error' => 'write_unavailable'], $body);
    }

    public function testControllerLabScopeCannotPromoteDemographics(): void
    {
        // An over-broadly minted lab token (with `user/DiagnosticReport.cs` only)
        // must not be able to write demographics. The dispatchDemographics
        // branch demands SCOPE_DEMOGRAPHICS explicitly.
        $token = $this->mintToken([PromoteController::SCOPE_LAB]);
        [$status, $body] = $this->dispatchController(
            $token,
            'demographics',
            $this->validBody(),
        );

        $this->assertSame(403, $status);
        $this->assertSame(['error' => 'scope_not_permitted'], $body);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private function buildRequest(
        DemographicsField $field = DemographicsField::Address,
        string $value = '742 Evergreen Terrace, Springfield IL 62701',
    ): DemographicsPromotionRequest {
        return new DemographicsPromotionRequest(
            pid: 4242,
            sourceDocumentUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            field: $field,
            value: $value,
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
            'field' => 'address',
            'value' => '742 Evergreen Terrace, Springfield IL 62701',
        ];
    }

    private function makeService(
        InMemoryDemographicsTableWriter $writer,
        ?DemographicsRecordingEventDispatcher $events = null,
    ): PatientDemographicsWriteService {
        return new PatientDemographicsWriteService(
            tableWriter: $writer,
            eventDispatcher: $events ?? new DemographicsRecordingEventDispatcher(),
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
        ?InMemoryDemographicsTableWriter $writer = null,
    ): array {
        $logger = new NullLogger();
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new DemographicsStubResolver(
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

        $demographicsService = $this->makeService(
            $writer ?? new InMemoryDemographicsTableWriter(
                [4242 => InMemoryDemographicsTableWriter::PATIENT_UUID],
            ),
            null,
        );

        // Lab + allergy + medical-problem + medication-statement +
        // family-history services are required by the controller's
        // constructor for the type signature but no demographics test
        // routes through their branches. No-op writers satisfy the type
        // without any setup cost.
        $labService = new ObservationLabWriteService(
            tableWriter: new NoopProcedureReportTableWriterForDemographics(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $allergyService = new AllergyListWriteService(
            tableWriter: new NoopAllergyTableWriterForDemographics(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $medicalProblemService = new MedicalProblemWriteService(
            tableWriter: new NoopMedicalProblemTableWriterForDemographics(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $medicationService = new MedicationStatementWriteService(
            tableWriter: new NoopMedicationStatementTableWriterForDemographics(),
            eventDispatcher: $dispatcher,
            clock: $this->fixedClock(),
            logger: $logger,
        );
        $familyHistoryService = new FamilyHistoryWriteService(
            tableWriter: new NoopFamilyHistoryTableWriterForDemographics(),
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
            demographicsWriteService: $demographicsService,
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
        return new DemographicsFixedClock(new DateTimeImmutable(self::FIXED_NOW));
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
            new DemographicsFixedJti(self::FIXED_JTI),
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

final class InMemoryDemographicsTableWriter implements PatientDemographicsTableWriter
{
    public const PATIENT_UUID = 'pppppppp-1111-2222-3333-444444444444';

    /** @var list<array{pid: int, field: DemographicsField, value: string, promotedByUserId: int}> */
    public array $updates = [];

    /**
     * @param array<int, string> $patientUuids pid → uuid string
     * @param array<int, array<string, string>> $columnValues pid → field-value → string
     */
    public function __construct(
        private array $patientUuids = [],
        private array $columnValues = [],
        private readonly bool $failOnUpdate = false,
    ) {
    }

    public function fetchSnapshot(
        int $pid,
        DemographicsField $field,
    ): ?PatientDemographicsSnapshot {
        if (!array_key_exists($pid, $this->patientUuids)) {
            return null;
        }
        $current = $this->columnValues[$pid][$field->value] ?? null;
        return new PatientDemographicsSnapshot(
            patientUuid: $this->patientUuids[$pid],
            currentValue: $current,
        );
    }

    public function updateField(
        int $pid,
        DemographicsField $field,
        string $value,
        int $promotedByUserId,
        \DateTimeImmutable $updatedAt,
    ): string {
        if ($this->failOnUpdate) {
            throw new \RuntimeException('simulated PatientService::databaseUpdate failure');
        }
        if (!array_key_exists($pid, $this->patientUuids)) {
            throw new \RuntimeException('patient not found in stub');
        }
        $this->updates[] = [
            'pid' => $pid,
            'field' => $field,
            'value' => $value,
            'promotedByUserId' => $promotedByUserId,
        ];
        $this->columnValues[$pid][$field->value] = $value;
        return $this->patientUuids[$pid];
    }
}

/**
 * No-op procedure-report writer for the demographics controller
 * tests. The controller's constructor needs the lab service for
 * type signature but no demographics test routes through the lab
 * branch.
 */
final class NoopProcedureReportTableWriterForDemographics implements ProcedureReportTableWriter
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
        throw new \RuntimeException(
            'NoopProcedureReportTableWriterForDemographics.insertPanel must not be called',
        );
    }
}

/**
 * No-op allergy writer for the demographics controller tests.
 */
final class NoopAllergyTableWriterForDemographics implements AllergyListsTableWriter
{
    public function findExistingAllergy(
        string $sourceDocumentUuid,
        string $normalizedSubstance,
    ): ?PersistedListEntry {
        return null;
    }

    public function insertAllergy(
        AllergyPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        throw new \RuntimeException(
            'NoopAllergyTableWriterForDemographics.insertAllergy must not be called',
        );
    }
}

/**
 * No-op medical-problem writer for the demographics controller tests.
 */
final class NoopMedicalProblemTableWriterForDemographics implements MedicalProblemListsTableWriter
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
            'NoopMedicalProblemTableWriterForDemographics.insertMedicalProblem must not be called',
        );
    }
}

/**
 * No-op medication-statement writer for the demographics controller tests.
 */
final class NoopMedicationStatementTableWriterForDemographics implements
    MedicationStatementListsTableWriter
{
    public function findExistingMedication(
        string $sourceDocumentUuid,
        string $normalizedDrugName,
    ): ?PersistedListEntry {
        return null;
    }

    public function insertMedication(
        MedicationStatementPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        throw new \RuntimeException(
            'NoopMedicationStatementTableWriterForDemographics.insertMedication must not be called',
        );
    }
}

/**
 * No-op family-history writer for the demographics controller tests.
 */
final class NoopFamilyHistoryTableWriterForDemographics implements FamilyHistoryListsTableWriter
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
            'NoopFamilyHistoryTableWriterForDemographics.insertFamilyHistory must not be called',
        );
    }
}

final class DemographicsRecordingEventDispatcher implements
    \Symfony\Component\EventDispatcher\EventDispatcherInterface
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

final readonly class DemographicsFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class DemographicsFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class DemographicsStubResolver implements
    \OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver
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
