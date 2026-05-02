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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns the lab history for a single
 * analyte over a configurable lookback window.
 *
 * Maps 1:1 to `public/snapshot/lab-history.php` and to the agent's
 * `getLabHistory` tool. Powers UC2 (lab/vitals trend) — the agent
 * fetches the rolling history for one analyte (e.g. "Hemoglobin A1c"
 * for the last two years) so the synthesizer can answer "is this
 * trending up?" with each cited value tied to its source row.
 *
 * Scope and audit shape mirror {@see LabsController}: same
 * `user/Observation.rs` scope, same disclosure event, but
 * `action='lab-history'` so a compliance reviewer can distinguish a
 * trend-shaped follow-up from a regular labs read.
 */
final readonly class LabHistoryController
{
    private const MAX_LOOKBACK_DAYS = 3650;
    private const MAX_ANALYTE_LENGTH = 200;

    public function __construct(
        private AgentEndpointAuth $auth,
        private ObservationAdapter $observationAdapter,
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
        ?string $analyte,
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
        if ($analyte === null || $analyte === '' || strlen($analyte) > self::MAX_ANALYTE_LENGTH) {
            $this->respondError(400, 'invalid_analyte');
            return;
        }
        if ($lookbackDays === null || $lookbackDays <= 0 || $lookbackDays > self::MAX_LOOKBACK_DAYS) {
            $this->respondError(400, 'invalid_lookback_days');
            return;
        }

        try {
            $labs = $this->observationAdapter->fetchHistoryByAnalyte($pid, $analyte, $lookbackDays);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent lab-history fetch failed', [
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
                    action: 'lab-history',
                    requestId: $request->verified->jti,
                    categories: ['lab'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent lab-history disclosure write failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'labs' => array_map(static fn($l) => $l->toArray(), $labs),
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
