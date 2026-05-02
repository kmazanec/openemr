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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns recent prescriptions for a patient
 * (active rows plus inactive rows modified within the lookback window).
 *
 * Maps 1:1 to `public/snapshot/prescriptions.php` and to the agent's
 * `getPrescriptions` tool. Runs only the {@see PrescriptionAdapter} —
 * no other adapters touch this request — so the conversational
 * follow-up path pays exactly the cost of the data the model needs.
 *
 * Audit row carries `action='prescriptions'` so a compliance reviewer
 * can distinguish a narrow follow-up from a full briefing snapshot.
 */
final readonly class PrescriptionsController
{
    public function __construct(
        private AgentEndpointAuth $auth,
        private PrescriptionAdapter $prescriptionAdapter,
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
    ): void {
        $request = $this->auth->authorize($bearerToken, 'user/MedicationRequest.rs');
        if ($request === null) {
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        try {
            $prescriptions = $this->prescriptionAdapter->fetchRecent($pid);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent prescriptions fetch failed', [
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
                    action: 'prescriptions',
                    requestId: $request->verified->jti,
                    categories: ['prescription'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent prescriptions disclosure write failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'prescriptions' => array_map(static fn($p) => $p->toArray(), $prescriptions),
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
