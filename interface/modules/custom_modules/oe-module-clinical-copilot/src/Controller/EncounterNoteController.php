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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterNoteAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns the SOAP note(s) attached to a
 * single encounter for a single patient.
 *
 * Maps 1:1 to `public/snapshot/encounter-note.php` and to the agent's
 * `getEncounterNote` tool. Powers follow-ups like "what was documented
 * at the last visit?" without paying for a full chart snapshot.
 *
 * Scoped under `user/Encounter.rs` because the data is encounter-bound
 * chart material; the briefing's allowlist already grants this scope.
 * The PID predicate enforced at the data-source layer stops a caller
 * authorized for patient A from probing patient B by encounter id.
 */
final readonly class EncounterNoteController
{
    public function __construct(
        private AgentEndpointAuth $auth,
        private EncounterNoteAdapter $encounterNoteAdapter,
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
        ?int $encounterId,
    ): void {
        $request = $this->auth->authorize($bearerToken, 'user/Encounter.rs');
        if ($request === null) {
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }
        if ($encounterId === null || $encounterId <= 0) {
            $this->respondError(400, 'invalid_encounter_id');
            return;
        }

        try {
            $notes = $this->encounterNoteAdapter->fetchForEncounter($pid, $encounterId);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent encounter-note fetch failed', [
                'pid' => $pid,
                'encounterId' => $encounterId,
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
                    action: 'encounter-note',
                    requestId: $request->verified->jti,
                    categories: ['encounter'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent encounter-note disclosure write failed', [
                'pid' => $pid,
                'encounterId' => $encounterId,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'notes' => array_map(static fn($n) => $n->toArray(), $notes),
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
