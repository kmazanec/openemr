<?php

/**
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\VitalsAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns history for a single vital type
 * (BP, weight, pulse, ...) over a configurable lookback window.
 *
 * Sibling of {@see LabHistoryController} — same audit-row shape and
 * same `user/Observation.rs` scope, but `action='vitals-history'` so
 * compliance can distinguish a vitals-trend follow-up from a labs
 * trend or a flat vitals read.
 *
 * The vital-type token is validated against
 * {@see VitalsAdapter::VITAL_TYPES} before reaching the data source so
 * an authorized caller cannot inject a column or index a hidden row.
 */
final readonly class VitalsHistoryController
{
    private const MAX_LOOKBACK_DAYS = 3650;

    public function __construct(
        private AgentEndpointAuth $auth,
        private VitalsAdapter $vitalsAdapter,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
    ) {
    }

    public function handle(
        ?string $bearerToken,
        ?int $pid,
        ?string $conversationId,
        ?string $vitalType,
        ?int $lookbackDays,
    ): void {
        $request = $this->auth->authorize($bearerToken, 'user/Observation.rs');
        if ($request === null) {
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }
        if ($vitalType === null || !array_key_exists($vitalType, VitalsAdapter::VITAL_TYPES)) {
            $this->respondError(400, 'invalid_vital_type');
            return;
        }
        if ($lookbackDays === null || $lookbackDays <= 0 || $lookbackDays > self::MAX_LOOKBACK_DAYS) {
            $this->respondError(400, 'invalid_lookback_days');
            return;
        }

        try {
            $vitals = $this->vitalsAdapter->fetchHistory($pid, $vitalType, $lookbackDays);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent vitals-history fetch failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'snapshot_unavailable');
            return;
        }

        $now = $this->clock->now();
        try {
            $this->eventDispatcher->dispatch(
                new AgentDisclosedEvent(new AgentDisclosure(
                    disclosedAt: $now,
                    actorUserId: $request->actor->userId,
                    actorFhirUser: $request->verified->fhirUser,
                    siteId: $this->siteId,
                    patientPid: $pid,
                    patientUuid: null,
                    conversationId: $conversationId,
                    action: 'vitals-history',
                    requestId: $request->verified->jti,
                    categories: ['vitals'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent vitals-history disclosure write failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'vitals' => array_map(static fn($v) => $v->toArray(), $vitals),
        ]);
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
