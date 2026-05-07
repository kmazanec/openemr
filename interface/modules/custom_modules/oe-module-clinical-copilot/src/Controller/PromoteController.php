<?php

/**
 * Tier-3 promotion endpoint controller.
 *
 * Single agent-facing entry for "clinician accepted an extracted fact;
 * write it to the chart." Dispatches on the `?type=` query parameter
 * to a per-fact-type handler. F.2 wires the `lab` path through
 * {@see ObservationLabWriteService}; F.5b adds the `allergy` path
 * through {@see AllergyListWriteService}; F.5c adds the
 * `medication_statement` path (patient-reported medications) through
 * {@see MedicationStatementWriteService}; F.5d adds the
 * `past_medical_history` path through {@see MedicalProblemWriteService};
 * F.5e adds the `family_history` path through
 * {@see FamilyHistoryWriteService}; F.6 adds the `demographics` path
 * through {@see PatientDemographicsWriteService}, which routes through
 * OpenEMR's standard `PatientService::databaseUpdate()` so the
 * existing audit log + `PatientUpdatedEvent` listeners fire as if
 * a clinician edited the demographics form. F.6 was the last per-type
 * branch — every VALID_TYPE now has a real dispatch arm. Adding a
 * new VALID_TYPE without a matching `match` arm fails PHPStan
 * exhaustiveness with `match.unhandled`, which is a stronger
 * structural signal than the F.5-era 501 branch was.
 *
 * Auth surface mirrors the narrow snapshot controllers (JWT bearer →
 * {@see AgentEndpointAuth}). Required scopes are per-type
 * (`user/DiagnosticReport.cs` for `lab`,
 * `user/AllergyIntolerance.cs` for `allergy`,
 * `user/MedicationStatement.cs` for `medication_statement`,
 * `user/Condition.cs` for `past_medical_history`,
 * `user/FamilyMemberHistory.cs` for `family_history`,
 * `user/Patient.cs` for `demographics`). The single-controller
 * approach is deliberate per the F.2 checklist — one entry, one
 * disclosure shape, one place to add a new type — but each branch
 * enforces its own scope so a token over-broadly minted for `lab`
 * cannot be reused to write demographics.
 *
 * Disclosure shape: every promotion fires
 * {@see AgentDisclosedEvent} with `action='tier3_promotion'` and a
 * type-specific data category (`['lab']`, `['allergy']`,
 * `['demographics']`, …) so compliance reviewers can see "lab was
 * promoted to chart from source document X."
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\Service\AllergyListWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicalProblemWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationLabWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\PatientDemographicsWriteService;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class PromoteController
{
    public const TYPE_LAB = 'lab';
    public const TYPE_ALLERGY = 'allergy';
    public const TYPE_MEDICATION_STATEMENT = 'medication_statement';
    public const TYPE_PAST_MEDICAL_HISTORY = 'past_medical_history';
    public const TYPE_FAMILY_HISTORY = 'family_history';
    public const TYPE_DEMOGRAPHICS = 'demographics';

    public const SCOPE_LAB = 'user/DiagnosticReport.cs';
    public const SCOPE_ALLERGY = 'user/AllergyIntolerance.cs';
    public const SCOPE_MEDICAL_PROBLEM = 'user/Condition.cs';
    public const SCOPE_MEDICATION_STATEMENT = 'user/MedicationStatement.cs';
    // F.5e — family-history Tier-3 writes use the dedicated
    // `FamilyMemberHistory` FHIR scope (vs reusing `Condition.cs`)
    // so an over-broadly minted Condition token (which the
    // past-medical-history branch uses) cannot smuggle through and
    // write a family-history row.
    public const SCOPE_FAMILY_HISTORY = 'user/FamilyMemberHistory.cs';
    // F.6 — demographics Tier-3 writes use the FHIR `Patient`
    // resource's content-write scope. Each accept click promotes one
    // (address|phone|email) delta through OpenEMR's standard
    // `PatientService::databaseUpdate()` surface; this scope is the
    // right semantic match because the chart effect is "write to the
    // Patient resource."
    public const SCOPE_DEMOGRAPHICS = 'user/Patient.cs';

    private const ACTION = 'tier3_promotion';
    private const CHART_RECORD_TYPE_DIAGNOSTIC_REPORT = 'diagnostic_report';
    private const CHART_RECORD_TYPE_LIST_ALLERGY = 'list_allergy';
    private const CHART_RECORD_TYPE_LIST_MEDICAL_PROBLEM = 'list_medical_problem';
    private const CHART_RECORD_TYPE_LIST_MEDICATION_STATEMENT = 'list_medication_statement';
    private const CHART_RECORD_TYPE_LIST_FAMILY_HISTORY = 'list_family_history';
    private const CHART_RECORD_TYPE_PATIENT_DEMOGRAPHICS = 'patient_demographics';

    private const VALID_TYPES = [
        self::TYPE_LAB,
        self::TYPE_ALLERGY,
        self::TYPE_MEDICATION_STATEMENT,
        self::TYPE_PAST_MEDICAL_HISTORY,
        self::TYPE_FAMILY_HISTORY,
        self::TYPE_DEMOGRAPHICS,
    ];

    public function __construct(
        private AgentEndpointAuth $auth,
        private ObservationLabWriteService $labWriteService,
        private AllergyListWriteService $allergyWriteService,
        private MedicalProblemWriteService $medicalProblemWriteService,
        private MedicationStatementWriteService $medicationStatementWriteService,
        private FamilyHistoryWriteService $familyHistoryWriteService,
        private PatientDemographicsWriteService $demographicsWriteService,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @param array<string, mixed>|null $body
     */
    public function dispatch(
        ?string $bearerToken,
        ?string $type,
        ?array $body,
        ?string $conversationId,
    ): void {
        if ($type === null || !in_array($type, self::VALID_TYPES, true)) {
            $this->respondError(400, 'invalid_type');
            return;
        }

        // F.6 — every VALID_TYPE now has a real dispatch arm.
        // PHPStan's match exhaustiveness check on the call below is
        // what keeps a future "added a VALID_TYPE without wiring a
        // match arm" change from compiling: it surfaces as
        // `match.unhandled`. Stronger structural signal than the
        // F.5-era 501 fallthrough.
        match ($type) {
            self::TYPE_LAB => $this->dispatchLab($bearerToken, $body, $conversationId),
            self::TYPE_ALLERGY => $this->dispatchAllergy($bearerToken, $body, $conversationId),
            self::TYPE_MEDICATION_STATEMENT => $this->dispatchMedicationStatement(
                $bearerToken,
                $body,
                $conversationId,
            ),
            self::TYPE_PAST_MEDICAL_HISTORY => $this->dispatchMedicalProblem(
                $bearerToken,
                $body,
                $conversationId,
            ),
            self::TYPE_FAMILY_HISTORY => $this->dispatchFamilyHistory(
                $bearerToken,
                $body,
                $conversationId,
            ),
            self::TYPE_DEMOGRAPHICS => $this->dispatchDemographics(
                $bearerToken,
                $body,
                $conversationId,
            ),
        };
    }

    /**
     * @param array<string, mixed>|null $body
     */
    private function dispatchLab(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::SCOPE_LAB);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $promotion = LabPromotionRequestParser::parse($body, $request->actor->userId);
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-3 lab promotion rejected at parse', [
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $result = $this->labWriteService->write($promotion);
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-3 lab promotion failed', [
                'pid' => $promotion->pid,
                'sourceDocumentUuid' => $promotion->sourceDocumentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
        }

        if (!$result->idempotentHit) {
            $this->fireDisclosure(
                request: $request,
                pid: $promotion->pid,
                conversationId: $conversationId,
                categories: ['lab'],
                chartRecordUuid: $result->diagnosticReportUuid,
                chartRecordTypeForLog: self::CHART_RECORD_TYPE_DIAGNOSTIC_REPORT,
            );
        }

        $this->respondJson(200, [
            'chart_record_uuid' => $result->diagnosticReportUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_DIAGNOSTIC_REPORT,
            'observation_uuids' => $result->observationUuids,
            'idempotent_hit' => $result->idempotentHit,
        ]);
    }

    /**
     * @param array<string, mixed>|null $body
     */
    private function dispatchAllergy(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::SCOPE_ALLERGY);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $promotion = AllergyPromotionRequestParser::parse($body, $request->actor->userId);
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-3 allergy promotion rejected at parse', [
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $result = $this->allergyWriteService->write($promotion);
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-3 allergy promotion failed', [
                'pid' => $promotion->pid,
                'sourceDocumentUuid' => $promotion->sourceDocumentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
        }

        if (!$result->idempotentHit) {
            $this->fireDisclosure(
                request: $request,
                pid: $promotion->pid,
                conversationId: $conversationId,
                categories: ['allergy'],
                chartRecordUuid: $result->listUuid,
                chartRecordTypeForLog: self::CHART_RECORD_TYPE_LIST_ALLERGY,
            );
        }

        $this->respondJson(200, [
            'chart_record_uuid' => $result->listUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_LIST_ALLERGY,
            'idempotent_hit' => $result->idempotentHit,
        ]);
    }

    /**
     * @param array<string, mixed>|null $body
     */
    private function dispatchMedicationStatement(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::SCOPE_MEDICATION_STATEMENT);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $promotion = MedicationStatementPromotionRequestParser::parse(
                $body,
                $request->actor->userId,
            );
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-3 medication_statement promotion rejected at parse', [
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $result = $this->medicationStatementWriteService->write($promotion);
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-3 medication_statement promotion failed', [
                'pid' => $promotion->pid,
                'sourceDocumentUuid' => $promotion->sourceDocumentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
        }

        if (!$result->idempotentHit) {
            $this->fireDisclosure(
                request: $request,
                pid: $promotion->pid,
                conversationId: $conversationId,
                categories: ['medication_statement'],
                chartRecordUuid: $result->listUuid,
                chartRecordTypeForLog: self::CHART_RECORD_TYPE_LIST_MEDICATION_STATEMENT,
            );
        }

        $this->respondJson(200, [
            'chart_record_uuid' => $result->listUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_LIST_MEDICATION_STATEMENT,
            'idempotent_hit' => $result->idempotentHit,
        ]);
    }

    /**
     * @param array<string, mixed>|null $body
     */
    private function dispatchMedicalProblem(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::SCOPE_MEDICAL_PROBLEM);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $promotion = MedicalProblemPromotionRequestParser::parse($body, $request->actor->userId);
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-3 medical-problem promotion rejected at parse', [
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $result = $this->medicalProblemWriteService->write($promotion);
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-3 medical-problem promotion failed', [
                'pid' => $promotion->pid,
                'sourceDocumentUuid' => $promotion->sourceDocumentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
        }

        if (!$result->idempotentHit) {
            $this->fireDisclosure(
                request: $request,
                pid: $promotion->pid,
                conversationId: $conversationId,
                categories: ['past_medical_history'],
                chartRecordUuid: $result->listUuid,
                chartRecordTypeForLog: self::CHART_RECORD_TYPE_LIST_MEDICAL_PROBLEM,
            );
        }

        $this->respondJson(200, [
            'chart_record_uuid' => $result->listUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_LIST_MEDICAL_PROBLEM,
            'idempotent_hit' => $result->idempotentHit,
        ]);
    }

    /**
     * @param array<string, mixed>|null $body
     */
    private function dispatchFamilyHistory(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::SCOPE_FAMILY_HISTORY);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $promotion = FamilyHistoryPromotionRequestParser::parse(
                $body,
                $request->actor->userId,
            );
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-3 family-history promotion rejected at parse', [
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $result = $this->familyHistoryWriteService->write($promotion);
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-3 family-history promotion failed', [
                'pid' => $promotion->pid,
                'sourceDocumentUuid' => $promotion->sourceDocumentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
        }

        if (!$result->idempotentHit) {
            $this->fireDisclosure(
                request: $request,
                pid: $promotion->pid,
                conversationId: $conversationId,
                categories: ['family_history'],
                chartRecordUuid: $result->listUuid,
                chartRecordTypeForLog: self::CHART_RECORD_TYPE_LIST_FAMILY_HISTORY,
            );
        }

        $this->respondJson(200, [
            'chart_record_uuid' => $result->listUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_LIST_FAMILY_HISTORY,
            'idempotent_hit' => $result->idempotentHit,
        ]);
    }

    /**
     * @param array<string, mixed>|null $body
     */
    private function dispatchDemographics(
        ?string $bearerToken,
        ?array $body,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, self::SCOPE_DEMOGRAPHICS);
        if ($request === null) {
            return;
        }

        if ($body === null) {
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $promotion = DemographicsPromotionRequestParser::parse(
                $body,
                $request->actor->userId,
            );
        } catch (\DomainException $e) {
            $this->logger->warning('Tier-3 demographics promotion rejected at parse', [
                'reason' => $e->getMessage(),
            ]);
            $this->respondError(400, 'invalid_body');
            return;
        }

        try {
            $result = $this->demographicsWriteService->write($promotion);
        } catch (\RuntimeException $e) {
            $this->logger->error('Tier-3 demographics promotion failed', [
                'pid' => $promotion->pid,
                'field' => $promotion->field->value,
                'sourceDocumentUuid' => $promotion->sourceDocumentUuid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'write_unavailable');
            return;
        }

        // Disclosure-event idempotency: the chart write only happens
        // on a non-idempotent hit, so the disclosure event only fires
        // there too. An idempotent re-call is a structural no-op for
        // both the chart and the audit trail — `extended_log` /
        // `agent_request_log` say "the agent disclosed PHI for one
        // Tier-3 promotion," not two. See {@see fireDisclosure()}'s
        // docblock for the full rationale.
        if (!$result->idempotentHit) {
            $this->fireDisclosure(
                request: $request,
                pid: $promotion->pid,
                conversationId: $conversationId,
                categories: ['demographics'],
                chartRecordUuid: $result->patientUuid,
                chartRecordTypeForLog: self::CHART_RECORD_TYPE_PATIENT_DEMOGRAPHICS,
            );
        }

        $this->respondJson(200, [
            'chart_record_uuid' => $result->patientUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_PATIENT_DEMOGRAPHICS,
            'idempotent_hit' => $result->idempotentHit,
        ]);
    }

    /**
     * Shared disclosure-event dispatch for every per-type branch. The
     * chart write has already landed by the time this fires — refusing
     * to acknowledge a disclosure failure here would create a
     * phantom-mismatch between OpenEMR and the agent's
     * `extracted_fact_dispositions`, so the F.2 contract is "log
     * loudly, respond success." Same shape for every fact type;
     * categories vary.
     *
     * Idempotency contract: this is *only* called when the write
     * service actually wrote a chart row (i.e. `result.idempotentHit
     * === false`). The per-branch dispatch arms gate the call with
     * `if (!$result->idempotentHit)` so an idempotent re-call (a
     * second clinician click on the same fact, a network retry, etc.)
     * is a structural no-op for both the chart row and the audit
     * trail. The `extended_log` + `agent_request_log` rows say "the
     * agent disclosed PHI for one Tier-3 promotion," not two.
     *
     * @param list<string> $categories
     */
    private function fireDisclosure(
        \OpenEMR\Modules\ClinicalCopilot\Auth\AuthorizedAgentRequest $request,
        int $pid,
        ?string $conversationId,
        array $categories,
        string $chartRecordUuid,
        string $chartRecordTypeForLog,
    ): void {
        try {
            $this->eventDispatcher->dispatch(
                new AgentDisclosedEvent(new AgentDisclosure(
                    disclosedAt: $this->clock->now(),
                    actorUserId: $request->actor->userId,
                    actorFhirUser: $request->verified->fhirUser,
                    siteId: $this->siteId,
                    patientPid: $pid,
                    patientUuid: null,
                    conversationId: $conversationId,
                    action: self::ACTION,
                    requestId: $request->verified->jti,
                    categories: $categories,
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Tier-3 disclosure write failed (chart row already persisted)', [
                'pid' => $pid,
                'chartRecordType' => $chartRecordTypeForLog,
                'chartRecordUuid' => $chartRecordUuid,
                'exception' => $e,
            ]);
        }
    }

    private function respondError(int $status, string $code): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }

    /**
     * @param array<string, mixed> $body
     */
    private function respondJson(int $status, array $body): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode($body, JSON_THROW_ON_ERROR);
    }
}
