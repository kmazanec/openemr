<?php

/**
 * Narrow agent endpoint for the §4.6.6 patient-reported medication
 * detail drill-down. Returns the documented details of a single
 * `lists` row (medication statement) so the
 * `medicationStatementBranch` graph node can build a deterministic
 * claim from the dose instructions, usage category, information
 * source, and any linked prescription rather than asking the model
 * to invent.
 *
 * Maps 1:1 to `public/snapshot/medication_statement_provenance.php`
 * and to the agent's `getMedicationStatementProvenance` tool. Audit
 * row carries `action='medication_statement_provenance'`.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementProvenanceAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class MedicationStatementProvenanceController
{
    public function __construct(
        private AgentEndpointAuth $auth,
        private MedicationStatementProvenanceAdapter $adapter,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
    ) {
    }

    public function handle(
        ?string $bearerToken,
        ?int $pid,
        ?int $listId,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, 'user/MedicationStatement.rs');
        if ($request === null) {
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        if ($listId === null || $listId <= 0) {
            $this->respondError(400, 'missing_list_id');
            return;
        }

        try {
            $provenance = $this->adapter->fetchByPid($pid, $listId);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent medication statement provenance fetch failed', [
                'pid' => $pid,
                'listId' => $listId,
                'exception' => $e,
            ]);
            $this->respondError(503, 'snapshot_unavailable');
            return;
        }

        if ($provenance === null) {
            $this->respondError(404, 'not_found');
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
                    action: 'medication_statement_provenance',
                    requestId: $request->verified->jti,
                    categories: ['medication_statement'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent medication statement provenance disclosure write failed', [
                'pid' => $pid,
                'listId' => $listId,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'provenance' => $provenance->toArray(),
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
