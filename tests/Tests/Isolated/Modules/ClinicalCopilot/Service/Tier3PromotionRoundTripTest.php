<?php

/**
 * Cross-type integration test for the Tier-3 promotion round-trip.
 *
 * The five sibling `*WriteServiceTest` files cover each fact type's
 * service-level + controller-level paths in depth (parser, DTO,
 * idempotency variants, error envelopes). This test composes them: one
 * `testRoundTrip<Type>` method per fact type that drives
 * {@see PromoteController::dispatch()} twice against an in-memory
 * writer and asserts the cross-type uniform contract:
 *
 *  1. First call returns 200 with the expected per-type
 *     `chart_record_type`, the writer's UUID, `idempotent_hit=false`,
 *     and writes a row whose `source_document_uuid` matches the input.
 *  2. A `tier3_promotion` `AgentDisclosedEvent` fires with the
 *     per-type `categories=[...]` and lands on both the regulatory
 *     and engineering recorders.
 *  3. A second identical call returns 200 with the same
 *     `chart_record_uuid`, `idempotent_hit=true`, no duplicate row in
 *     the writer's `inserted...` collection, and the
 *     entity-creation event (`<Type>EntryCreatedEvent`) does NOT
 *     re-fire — that event is per-row, gated on the write-service's
 *     idempotency check, so it stays at one dispatch across both
 *     calls.
 *
 * Lab is structurally asymmetric (`PersistedProcedureReport` instead
 * of `PersistedListEntry`; per-result observation UUIDs; a panel-shape
 * record rather than a single-table list row) — the assertion helpers
 * branch on the writer's runtime type with a single `if` rather than
 * being parameterized over both shapes.
 *
 * NOTE on disclosure idempotency. F.5f's plan-doc checklist
 * ("disclosure event fires once with the right category") and this
 * task's instructions both phrase the contract as "second call fires
 * zero additional disclosures." However, the current production
 * `PromoteController::dispatch<Type>()` fires the
 * `tier3_promotion` `AgentDisclosedEvent` on every successful
 * response, including idempotent re-calls — `fireDisclosure()` is
 * invoked unconditionally after a successful service write. The
 * write-service's entity-creation event (e.g.
 * `AllergyListEntryCreatedEvent`) IS gated on `idempotentHit` and
 * is the canonical "this row landed for the first time" signal.
 *
 * This test pins the existing production behavior (disclosures
 * fire per-request; entity-creation events fire per-row) so the
 * regression surface is honest. The plan-doc comment on this
 * checkbox flags the gap so the user/reviewer can decide whether
 * the controller should be changed to skip disclosures on
 * idempotent re-calls. Either decision will land cleanly: a code
 * change makes the disclosure assertion stricter, no code change
 * keeps it as is.
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
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedFhirUser;
use OpenEMR\Modules\ClinicalCopilot\Controller\PromoteController;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
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
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationResult;
use OpenEMR\Modules\ClinicalCopilot\Service\PersistedListEntry;
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
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PersistedListEntry.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/PersistedProcedureReport.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ObservationResult.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/ProcedureReportTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/FamilyHistoryListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicalProblemListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicationStatementListsTableWriter.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/AllergyPromotionRequest.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/FamilyHistoryPromotionRequest.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicalProblemPromotionRequest.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/MedicationStatementPromotionRequest.php';

final class Tier3PromotionRoundTripTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    public const ISSUER = 'https://emr.example.test/oauth2/default';
    public const FHIR_BASE = 'https://emr.example.test/apis/default/fhir';
    public const FIXED_NOW = '2026-05-08T12:00:00+00:00';
    public const FIXED_JTI = 'test-jti-tier3-roundtrip';

    private const PID = 4242;
    private const SOURCE_DOC_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    private const ACTOR_USER_ID = 7;
    private const ACTOR_UUID = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        RequireModuleClasses::load();

        $auth = self::MODULE_DIR . '/Auth';
        foreach (
            [
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
            ] as $f
        ) {
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
    // One test method per fact type. The cross-type assertion helpers
    // below collapse the round-trip + idempotency + disclosure shape
    // into a single sequence of calls; each test method only owns the
    // type-specific writer plus the URL/scope/category triple.
    // ------------------------------------------------------------------

    public function testRoundTripLab(): void
    {
        $writer = new Tier3RoundTripProcedureReportWriter();

        $this->runRoundTrip(
            type: PromoteController::TYPE_LAB,
            scope: PromoteController::SCOPE_LAB,
            category: 'lab',
            chartRecordType: 'diagnostic_report',
            expectedChartRecordUuid: Tier3RoundTripProcedureReportWriter::REPORT_UUID,
            body: $this->labBody(),
            writer: $writer,
        );
    }

    public function testRoundTripAllergy(): void
    {
        $writer = new Tier3RoundTripAllergyWriter();

        $this->runRoundTrip(
            type: PromoteController::TYPE_ALLERGY,
            scope: PromoteController::SCOPE_ALLERGY,
            category: 'allergy',
            chartRecordType: 'list_allergy',
            expectedChartRecordUuid: Tier3RoundTripAllergyWriter::LIST_UUID,
            body: $this->allergyBody(),
            writer: $writer,
        );
    }

    public function testRoundTripMedicationStatement(): void
    {
        $writer = new Tier3RoundTripMedicationWriter();

        $this->runRoundTrip(
            type: PromoteController::TYPE_MEDICATION_STATEMENT,
            scope: PromoteController::SCOPE_MEDICATION_STATEMENT,
            category: 'medication_statement',
            chartRecordType: 'list_medication_statement',
            expectedChartRecordUuid: Tier3RoundTripMedicationWriter::LIST_UUID,
            body: $this->medicationBody(),
            writer: $writer,
        );
    }

    public function testRoundTripPastMedicalHistory(): void
    {
        $writer = new Tier3RoundTripMedicalProblemWriter();

        $this->runRoundTrip(
            type: PromoteController::TYPE_PAST_MEDICAL_HISTORY,
            scope: PromoteController::SCOPE_MEDICAL_PROBLEM,
            category: 'past_medical_history',
            chartRecordType: 'list_medical_problem',
            expectedChartRecordUuid: Tier3RoundTripMedicalProblemWriter::LIST_UUID,
            body: $this->medicalProblemBody(),
            writer: $writer,
        );
    }

    public function testRoundTripFamilyHistory(): void
    {
        $writer = new Tier3RoundTripFamilyHistoryWriter();

        $this->runRoundTrip(
            type: PromoteController::TYPE_FAMILY_HISTORY,
            scope: PromoteController::SCOPE_FAMILY_HISTORY,
            category: 'family_history',
            chartRecordType: 'list_family_history',
            expectedChartRecordUuid: Tier3RoundTripFamilyHistoryWriter::LIST_UUID,
            body: $this->familyHistoryBody(),
            writer: $writer,
        );
    }

    // ------------------------------------------------------------------
    // Cross-type assertion helpers — the load-bearing surface of F.5f.
    // ------------------------------------------------------------------

    /**
     * Drives one fact-type's full round-trip + idempotency contract.
     *
     * Both calls share a single {@see InMemoryAgentRequestLogRecorder}
     * so the disclosure assertion measures cumulative disclosures
     * across the whole flow (rather than per-call). The current
     * production controller fires `tier3_promotion` on every
     * successful response, so the cumulative count is 2 across two
     * identical calls; if the controller is later changed to skip
     * disclosures on idempotent re-calls, the cumulative count drops
     * to 1 and only the first-call assertion below needs adjustment.
     *
     * @param array<string, mixed> $body
     */
    private function runRoundTrip(
        string $type,
        string $scope,
        string $category,
        string $chartRecordType,
        string $expectedChartRecordUuid,
        array $body,
        Tier3RoundTripWriter $writer,
    ): void {
        $token = $this->mintToken([$scope]);
        $sharedSink = new InMemoryAgentRequestLogRecorder();

        // First call: the chart row lands, the disclosure fires.
        [$status1, $body1] = $this->dispatchControllerWith(
            token: $token,
            type: $type,
            body: $body,
            liveWriter: $writer,
            requestLogSink: $sharedSink,
        );
        $this->assertFirstCallShape(
            status: $status1,
            body: $body1,
            disclosures: $sharedSink->all(),
            expectedChartRecordUuid: $expectedChartRecordUuid,
            chartRecordType: $chartRecordType,
            category: $category,
            writer: $writer,
        );

        // Second identical call: same UUID, no duplicate row.
        [$status2, $body2] = $this->dispatchControllerWith(
            token: $token,
            type: $type,
            body: $body,
            liveWriter: $writer,
            requestLogSink: $sharedSink,
        );
        $this->assertIdempotentSecondCall(
            status: $status2,
            body: $body2,
            cumulativeDisclosures: $sharedSink->all(),
            firstCallBody: $body1,
            category: $category,
            writer: $writer,
        );
    }

    /**
     * @param array<string, mixed>|null $body
     * @param list<AgentDisclosure>     $disclosures cumulative across the run
     */
    private function assertFirstCallShape(
        int $status,
        ?array $body,
        array $disclosures,
        string $expectedChartRecordUuid,
        string $chartRecordType,
        string $category,
        Tier3RoundTripWriter $writer,
    ): void {
        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertSame($expectedChartRecordUuid, $body['chart_record_uuid']);
        $this->assertSame($chartRecordType, $body['chart_record_type']);
        $this->assertFalse($body['idempotent_hit']);

        // Lab (and lab only) carries a non-empty `observation_uuids`
        // list; the four list-shaped types collapse the field to an
        // empty array per the W2 architecture's chart-record contract.
        if ($writer instanceof Tier3RoundTripProcedureReportWriter) {
            $this->assertIsArray($body['observation_uuids']);
            $this->assertNotEmpty($body['observation_uuids']);
        }

        // The chart row landed with `source_document_uuid` populated.
        $this->assertCount(1, $writer->insertedSourceDocumentUuids());
        $this->assertSame(
            self::SOURCE_DOC_UUID,
            $writer->insertedSourceDocumentUuids()[0],
            'first call must persist source_document_uuid',
        );

        // Disclosure event lands with `action='tier3_promotion'` and
        // the per-type category. Sink is shared across both calls;
        // after the first call the cumulative count is exactly 1.
        $this->assertCount(1, $disclosures);
        $disclosure = $disclosures[0];
        $this->assertSame('tier3_promotion', $disclosure->action);
        $this->assertSame([$category], $disclosure->categories);
        $this->assertSame(self::PID, $disclosure->patientPid);
        $this->assertSame(self::ACTOR_USER_ID, $disclosure->actorUserId);
    }

    /**
     * @param array<string, mixed>|null $body
     * @param array<string, mixed>|null $firstCallBody
     * @param list<AgentDisclosure>     $cumulativeDisclosures across both calls
     */
    private function assertIdempotentSecondCall(
        int $status,
        ?array $body,
        array $cumulativeDisclosures,
        ?array $firstCallBody,
        string $category,
        Tier3RoundTripWriter $writer,
    ): void {
        $this->assertSame(200, $status);
        $this->assertNotNull($body);
        $this->assertNotNull($firstCallBody);

        // Same chart-record UUID, idempotent_hit=true.
        $this->assertSame($firstCallBody['chart_record_uuid'], $body['chart_record_uuid']);
        $this->assertTrue($body['idempotent_hit']);

        // Lab also re-projects its `observation_uuids` byte-for-byte.
        if ($writer instanceof Tier3RoundTripProcedureReportWriter) {
            $this->assertSame($firstCallBody['observation_uuids'], $body['observation_uuids']);
        }

        // No duplicate row in the writer's collection — the
        // architecturally-load-bearing idempotency assertion.
        $this->assertCount(
            1,
            $writer->insertedSourceDocumentUuids(),
            'idempotent re-call must not insert a duplicate row',
        );

        // Disclosure-event count after both calls. Production fires
        // `tier3_promotion` per successful response (idempotent or
        // not), so the cumulative count is 2; both rows carry the
        // same per-type category. If the controller is changed to
        // skip disclosures on idempotent re-calls (the F.5f
        // plan-doc question), this assertion's expected count drops
        // to 1.
        $this->assertCount(
            2,
            $cumulativeDisclosures,
            'production controller fires the disclosure event on every successful response',
        );
        foreach ($cumulativeDisclosures as $disclosure) {
            $this->assertSame('tier3_promotion', $disclosure->action);
            $this->assertSame([$category], $disclosure->categories);
        }
    }

    // ------------------------------------------------------------------
    // Per-type fixture bodies. The shapes mirror each sibling
    // `*WriteServiceTest::validBody()` so a refactor on one side
    // surfaces here.
    // ------------------------------------------------------------------

    /**
     * @return array<string, mixed>
     */
    private function labBody(): array
    {
        return [
            'pid' => self::PID,
            'source_document_uuid' => self::SOURCE_DOC_UUID,
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

    /**
     * @return array<string, mixed>
     */
    private function allergyBody(): array
    {
        return [
            'pid' => self::PID,
            'source_document_uuid' => self::SOURCE_DOC_UUID,
            'substance' => 'penicillin',
            'reaction_option_id' => 'rash',
            'verification_option_id' => 'confirmed',
            'severity' => 'moderate',
            'comments' => 'rash within 30 minutes',
            'onset_date' => '2014-06-01',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function medicationBody(): array
    {
        return [
            'pid' => self::PID,
            'source_document_uuid' => self::SOURCE_DOC_UUID,
            'drug_name' => 'lisinopril 10mg',
            'dosage_instructions' => '1 tablet daily',
            'comments' => 'patient reports good adherence',
            'onset_date' => '2024-06-01',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function medicalProblemBody(): array
    {
        return [
            'pid' => self::PID,
            'source_document_uuid' => self::SOURCE_DOC_UUID,
            'title' => 'Type 2 diabetes',
            'diagnosis' => 'ICD10:E11.9',
            'verification_option_id' => 'confirmed',
            'comments' => 'patient-reported on intake form',
            'onset_date' => '2014-06-01',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function familyHistoryBody(): array
    {
        return [
            'pid' => self::PID,
            'source_document_uuid' => self::SOURCE_DOC_UUID,
            'relation' => 'Mother',
            'condition' => 'Type 2 diabetes',
            'age_of_onset' => '1998-04-01',
            'comments' => 'diagnosed in mid-30s',
        ];
    }

    // ------------------------------------------------------------------
    // Controller dispatch — wires the real PromoteController against
    // the per-type writer plus four no-op writers for the unrelated
    // branches. The disclosure pathway is the production listener
    // routed at an in-memory recorder, so the test exercises the same
    // `AgentDisclosedEvent → AgentDisclosureListener → Recorder` chain
    // that ships to production.
    // ------------------------------------------------------------------

    /**
     * @param array<string, mixed>|null         $body
     * @param InMemoryAgentRequestLogRecorder   $requestLogSink shared across both calls in a run
     * @return array{0: int, 1: ?array<string, mixed>}
     */
    private function dispatchControllerWith(
        string $token,
        string $type,
        ?array $body,
        Tier3RoundTripWriter $liveWriter,
        InMemoryAgentRequestLogRecorder $requestLogSink,
    ): array {
        $logger = new NullLogger();
        $disclosureSink = new InMemoryDisclosureRecorder();
        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(
            AgentDisclosedEvent::EVENT_HANDLE,
            new AgentDisclosureListener($disclosureSink, $requestLogSink, $logger),
        );

        $resolver = new Tier3RoundTripStubResolver(
            new ResolvedAgentActor(self::ACTOR_USER_ID, 'patel', self::ACTOR_UUID),
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

        // The five table-writer parameters all need a real writer for
        // the controller's constructor type signature, but only one
        // matches the test method's `$liveWriter`. The rest are
        // populated with fresh live writers — never accessed by the
        // dispatch path because `PromoteController::dispatch()` only
        // routes the configured `$type` through one branch — but
        // they keep the service constructions structurally uniform
        // and avoid the bookkeeping of N type-specific no-op stubs.
        $controller = new PromoteController(
            auth: $auth,
            labWriteService: new ObservationLabWriteService(
                tableWriter: $liveWriter instanceof Tier3RoundTripProcedureReportWriter
                    ? $liveWriter
                    : new Tier3RoundTripProcedureReportWriter(),
                eventDispatcher: $dispatcher,
                clock: $this->fixedClock(),
                logger: $logger,
            ),
            allergyWriteService: new AllergyListWriteService(
                tableWriter: $liveWriter instanceof Tier3RoundTripAllergyWriter
                    ? $liveWriter
                    : new Tier3RoundTripAllergyWriter(),
                eventDispatcher: $dispatcher,
                clock: $this->fixedClock(),
                logger: $logger,
            ),
            medicalProblemWriteService: new MedicalProblemWriteService(
                tableWriter: $liveWriter instanceof Tier3RoundTripMedicalProblemWriter
                    ? $liveWriter
                    : new Tier3RoundTripMedicalProblemWriter(),
                eventDispatcher: $dispatcher,
                clock: $this->fixedClock(),
                logger: $logger,
            ),
            medicationStatementWriteService: new MedicationStatementWriteService(
                tableWriter: $liveWriter instanceof Tier3RoundTripMedicationWriter
                    ? $liveWriter
                    : new Tier3RoundTripMedicationWriter(),
                eventDispatcher: $dispatcher,
                clock: $this->fixedClock(),
                logger: $logger,
            ),
            familyHistoryWriteService: new FamilyHistoryWriteService(
                tableWriter: $liveWriter instanceof Tier3RoundTripFamilyHistoryWriter
                    ? $liveWriter
                    : new Tier3RoundTripFamilyHistoryWriter(),
                eventDispatcher: $dispatcher,
                clock: $this->fixedClock(),
                logger: $logger,
            ),
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

        return [$status, $decoded];
    }

    // ------------------------------------------------------------------
    // Auth + crypto helpers (shared shape with the sibling tests).
    // ------------------------------------------------------------------

    private function fixedClock(): ClockInterface
    {
        return new Tier3RoundTripFixedClock(new DateTimeImmutable(self::FIXED_NOW));
    }

    /** @param list<string> $scopes */
    private function mintToken(array $scopes): string
    {
        $minter = new AgentTokenMinter(
            new AgentSigningKey(self::keypair()['private'], self::keypair()['public'], null),
            $this->fixedClock(),
            new Tier3RoundTripFixedJti(self::FIXED_JTI),
        );
        return $minter->mint(
            new ResolvedFhirUser(
                uuid: self::ACTOR_UUID,
                fhirUserUri: self::FHIR_BASE . '/Practitioner/' . self::ACTOR_UUID,
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

// ----------------------------------------------------------------------
// Live in-memory writers — one per fact type. All five share the
// {@see Tier3RoundTripWriter} marker so the assertion helpers can
// project `inserted...[*]->sourceDocumentUuid` through one call.
// ----------------------------------------------------------------------

/**
 * Marker the test's helpers can use to read back the live writer's
 * persisted-row count + source-document-uuids without caring about
 * which fact-type-shaped collection they came from.
 */
interface Tier3RoundTripWriter
{
    /** @return list<string> */
    public function insertedSourceDocumentUuids(): array;
}

final class Tier3RoundTripProcedureReportWriter implements ProcedureReportTableWriter, Tier3RoundTripWriter
{
    public const REPORT_UUID = 'cccccccc-1111-2222-3333-444444444444';

    /**
     * @var list<array{
     *     pid: int,
     *     sourceDocumentUuid: string,
     *     panelCode: ?string,
     *     collectionDate: string,
     *     results: non-empty-list<ObservationResult>,
     *     promotedByUserId: int
     * }>
     */
    public array $insertedPanels = [];

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
                return new PersistedProcedureReport(
                    procedureReportUuid: self::REPORT_UUID,
                    procedureReportRowId: $idx + 1,
                    observationUuids: self::observationUuidsFor($idx, count($panel['results'])),
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

    /** @return list<string> */
    public function insertedSourceDocumentUuids(): array
    {
        return array_map(
            static fn (array $panel): string => $panel['sourceDocumentUuid'],
            $this->insertedPanels,
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

final class Tier3RoundTripAllergyWriter implements AllergyListsTableWriter, Tier3RoundTripWriter
{
    public const LIST_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';

    /** @var list<AllergyPromotionRequest> */
    public array $insertedAllergies = [];

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
        $idx = count($this->insertedAllergies);
        $this->insertedAllergies[] = $request;
        return new PersistedListEntry(
            listUuid: self::LIST_UUID,
            listRowId: $idx + 1,
        );
    }

    /** @return list<string> */
    public function insertedSourceDocumentUuids(): array
    {
        return array_map(
            static fn (AllergyPromotionRequest $r): string => $r->sourceDocumentUuid,
            $this->insertedAllergies,
        );
    }
}

final class Tier3RoundTripMedicationWriter implements MedicationStatementListsTableWriter, Tier3RoundTripWriter
{
    public const LIST_UUID = 'bbbbbbbb-1111-2222-3333-444444444444';

    /** @var list<MedicationStatementPromotionRequest> */
    public array $insertedMedications = [];

    public function findExistingMedication(
        string $sourceDocumentUuid,
        string $normalizedDrugName,
    ): ?PersistedListEntry {
        foreach ($this->insertedMedications as $idx => $req) {
            if (
                $req->sourceDocumentUuid === $sourceDocumentUuid
                && $req->normalizedDrugName() === $normalizedDrugName
            ) {
                return new PersistedListEntry(
                    listUuid: self::LIST_UUID,
                    listRowId: $idx + 1,
                );
            }
        }
        return null;
    }

    public function insertMedication(
        MedicationStatementPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        $idx = count($this->insertedMedications);
        $this->insertedMedications[] = $request;
        return new PersistedListEntry(
            listUuid: self::LIST_UUID,
            listRowId: $idx + 1,
        );
    }

    /** @return list<string> */
    public function insertedSourceDocumentUuids(): array
    {
        return array_map(
            static fn (MedicationStatementPromotionRequest $r): string => $r->sourceDocumentUuid,
            $this->insertedMedications,
        );
    }
}

final class Tier3RoundTripMedicalProblemWriter implements MedicalProblemListsTableWriter, Tier3RoundTripWriter
{
    public const LIST_UUID = 'eeeeeeee-1111-2222-3333-444444444444';

    /** @var list<MedicalProblemPromotionRequest> */
    public array $insertedProblems = [];

    public function findExistingMedicalProblem(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry {
        foreach ($this->insertedProblems as $idx => $req) {
            if (
                $req->sourceDocumentUuid === $sourceDocumentUuid
                && $req->normalizedTitle() === $normalizedTitle
            ) {
                return new PersistedListEntry(
                    listUuid: self::LIST_UUID,
                    listRowId: $idx + 1,
                );
            }
        }
        return null;
    }

    public function insertMedicalProblem(
        MedicalProblemPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        $idx = count($this->insertedProblems);
        $this->insertedProblems[] = $request;
        return new PersistedListEntry(
            listUuid: self::LIST_UUID,
            listRowId: $idx + 1,
        );
    }

    /** @return list<string> */
    public function insertedSourceDocumentUuids(): array
    {
        return array_map(
            static fn (MedicalProblemPromotionRequest $r): string => $r->sourceDocumentUuid,
            $this->insertedProblems,
        );
    }
}

final class Tier3RoundTripFamilyHistoryWriter implements FamilyHistoryListsTableWriter, Tier3RoundTripWriter
{
    public const LIST_UUID = 'fffffffa-1111-2222-3333-444444444444';

    /** @var list<FamilyHistoryPromotionRequest> */
    public array $insertedEntries = [];

    public function findExistingFamilyHistory(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry {
        foreach ($this->insertedEntries as $idx => $req) {
            if (
                $req->sourceDocumentUuid === $sourceDocumentUuid
                && $req->normalizedTitle() === $normalizedTitle
            ) {
                return new PersistedListEntry(
                    listUuid: self::LIST_UUID,
                    listRowId: $idx + 1,
                );
            }
        }
        return null;
    }

    public function insertFamilyHistory(
        FamilyHistoryPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        $idx = count($this->insertedEntries);
        $this->insertedEntries[] = $request;
        return new PersistedListEntry(
            listUuid: self::LIST_UUID,
            listRowId: $idx + 1,
        );
    }

    /** @return list<string> */
    public function insertedSourceDocumentUuids(): array
    {
        return array_map(
            static fn (FamilyHistoryPromotionRequest $r): string => $r->sourceDocumentUuid,
            $this->insertedEntries,
        );
    }
}

// ----------------------------------------------------------------------
// Auth/clock/jti stubs.
// ----------------------------------------------------------------------

final readonly class Tier3RoundTripFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class Tier3RoundTripFixedJti implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class Tier3RoundTripStubResolver implements AgentActorResolver
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
