<?php

/**
 * Tier-3 promotion endpoint controller.
 *
 * Single agent-facing entry for "clinician accepted an extracted fact;
 * write it to the chart." Dispatches on the `?type=` query parameter
 * to a per-fact-type handler. F.2 wires the `lab` path through
 * {@see ObservationLabWriteService}; F.5b adds the `allergy` path
 * through {@see AllergyListWriteService}; the remaining non-lab fact
 * types (`medication_statement`, `past_medical_history`,
 * `family_history`, `demographics`) are accepted by the dispatcher
 * but reject with HTTP 501 until F.5c–F.6 land. The 501 is
 * deliberately structural: the agent should not silently route a
 * Tier-3 promotion of an unimplemented type as if it succeeded.
 *
 * Auth surface mirrors the narrow snapshot controllers (JWT bearer →
 * {@see AgentEndpointAuth}). Required scopes are per-type
 * (`user/DiagnosticReport.cs` for `lab`,
 * `user/AllergyIntolerance.cs` for `allergy`); future fact-type
 * branches will require their own scopes (architecture's "Repeat
 * explicit checks at agent endpoints"). The single-controller
 * approach is deliberate per the F.2 checklist — one entry, one
 * disclosure shape, one place to add a new type — but each branch
 * enforces its own scope so a token over-broadly minted for `lab`
 * cannot be reused to write demographics.
 *
 * Disclosure shape: every promotion fires
 * {@see AgentDisclosedEvent} with `action='tier3_promotion'` and a
 * type-specific data category (`['lab']`, `['allergy']`, …) so
 * compliance reviewers can see "lab was promoted to chart from
 * source document X."
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
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationLabWriteService;
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

    private const ACTION = 'tier3_promotion';
    private const CHART_RECORD_TYPE_DIAGNOSTIC_REPORT = 'diagnostic_report';
    private const CHART_RECORD_TYPE_LIST_ALLERGY = 'list_allergy';

    private const VALID_TYPES = [
        self::TYPE_LAB,
        self::TYPE_ALLERGY,
        self::TYPE_MEDICATION_STATEMENT,
        self::TYPE_PAST_MEDICAL_HISTORY,
        self::TYPE_FAMILY_HISTORY,
        self::TYPE_DEMOGRAPHICS,
    ];

    private const NOT_YET_IMPLEMENTED_TYPES = [
        self::TYPE_MEDICATION_STATEMENT,
        self::TYPE_PAST_MEDICAL_HISTORY,
        self::TYPE_FAMILY_HISTORY,
        self::TYPE_DEMOGRAPHICS,
    ];

    public function __construct(
        private AgentEndpointAuth $auth,
        private ObservationLabWriteService $labWriteService,
        private AllergyListWriteService $allergyWriteService,
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

        if (in_array($type, self::NOT_YET_IMPLEMENTED_TYPES, true)) {
            // Authorize first so an unimplemented type still rejects an
            // unauthenticated request with 401, not 501. The 501 is
            // reserved for callers that *could* write but the
            // server-side handler isn't built yet. We use the lab
            // scope as a structural placeholder — once the type's
            // own scope lands, its dispatchX() method enforces it.
            $request = $this->auth->authorize($bearerToken, self::SCOPE_LAB);
            if ($request === null) {
                return;
            }
            $this->respondError(501, 'not_yet_implemented');
            return;
        }

        // After VALID_TYPES + NOT_YET_IMPLEMENTED filtering, $type is
        // exactly one of the implemented types. PHPStan sees this and
        // verifies match exhaustiveness — a future PR that adds a
        // new VALID_TYPE without flipping NOT_YET_IMPLEMENTED and
        // without wiring a match arm fails static analysis with
        // `match.unhandled`, which is a stronger signal than a runtime
        // default arm.
        match ($type) {
            self::TYPE_LAB => $this->dispatchLab($bearerToken, $body, $conversationId),
            self::TYPE_ALLERGY => $this->dispatchAllergy($bearerToken, $body, $conversationId),
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

        $this->fireDisclosure(
            request: $request,
            pid: $promotion->pid,
            conversationId: $conversationId,
            categories: ['lab'],
            chartRecordUuid: $result->diagnosticReportUuid,
            chartRecordTypeForLog: self::CHART_RECORD_TYPE_DIAGNOSTIC_REPORT,
        );

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

        $this->fireDisclosure(
            request: $request,
            pid: $promotion->pid,
            conversationId: $conversationId,
            categories: ['allergy'],
            chartRecordUuid: $result->listUuid,
            chartRecordTypeForLog: self::CHART_RECORD_TYPE_LIST_ALLERGY,
        );

        $this->respondJson(200, [
            'chart_record_uuid' => $result->listUuid,
            'chart_record_type' => self::CHART_RECORD_TYPE_LIST_ALLERGY,
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
