<?php

/**
 * Narrow agent endpoint for the §4.3 prescription-change drill-down
 * (USERS.md UC3). Returns the documented provenance of a single
 * prescription — date, prescriber, indication, dose — so the
 * `prescriptionChangeBranch` graph node can build a deterministic
 * claim from source fields rather than asking the model to infer them.
 *
 * Maps 1:1 to `public/snapshot/prescription_provenance.php` and to the
 * agent's `getPrescriptionProvenance` tool. Audit row carries
 * `action='prescription_provenance'`.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionProvenanceAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class PrescriptionProvenanceController
{
    public function __construct(
        private AgentEndpointAuth $auth,
        private PrescriptionProvenanceAdapter $adapter,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
    ) {
    }

    public function handle(
        ?string $bearerToken,
        ?int $pid,
        ?int $prescriptionId,
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

        if ($prescriptionId === null || $prescriptionId <= 0) {
            $this->respondError(400, 'missing_prescription_id');
            return;
        }

        try {
            $provenance = $this->adapter->fetchByPid($pid, $prescriptionId);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent prescription provenance fetch failed', [
                'pid' => $pid,
                'prescriptionId' => $prescriptionId,
                'exception' => $e,
            ]);
            $this->respondError(503, 'snapshot_unavailable');
            return;
        }

        if ($provenance === null) {
            // An unknown prescription id (or one that doesn't belong to
            // this patient) is a deterministic answer the branch must
            // surface — never a 5xx. The branch will render a "no record
            // found" connector segment from this.
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
                    action: 'prescription_provenance',
                    requestId: $request->verified->jti,
                    categories: ['prescription'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent prescription provenance disclosure write failed', [
                'pid' => $pid,
                'prescriptionId' => $prescriptionId,
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
