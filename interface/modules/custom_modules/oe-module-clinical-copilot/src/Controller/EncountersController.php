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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Encounter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns recent encounters for a patient.
 *
 * Maps 1:1 to `public/snapshot/encounters.php` and to the agent's
 * `getRecentEncounters` tool. Runs both {@see EncounterAdapter} (native
 * `form_encounter` rows, marked `source.system = 'openemr'`) and
 * {@see ExternalEncounterAdapter} (CCDA-imported rows from
 * `external_encounters`, marked `source.system = 'ccda-importer'`).
 * The two are merged into a single date-desc list before disclosure;
 * downstream consumers (the §4.1 follow-ups generator and the
 * verifier) distinguish them via `source.system`.
 *
 * Audit row carries `action='encounters'`.
 */
final readonly class EncountersController
{
    private const DEFAULT_LOOKBACK_DAYS = 365;

    public function __construct(
        private AgentEndpointAuth $auth,
        private EncounterAdapter $encounterAdapter,
        private ExternalEncounterAdapter $externalEncounterAdapter,
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
        $request = $this->auth->authorize($bearerToken, 'user/Encounter.rs');
        if ($request === null) {
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        try {
            $native = $this->encounterAdapter->fetchRecent($pid, self::DEFAULT_LOOKBACK_DAYS);
            $external = $this->externalEncounterAdapter->fetchRecent($pid, self::DEFAULT_LOOKBACK_DAYS);
            $encounters = $this->mergeEncounters($native, $external);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent encounters fetch failed', [
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
                    action: 'encounters',
                    requestId: $request->verified->jti,
                    categories: ['encounter'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent encounters disclosure write failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'encounters' => array_map(static fn($e) => $e->toArray(), $encounters),
        ]);
    }

    /**
     * @param list<Encounter> $native
     * @param list<Encounter> $external
     * @return list<Encounter>
     */
    private function mergeEncounters(array $native, array $external): array
    {
        $merged = array_merge($native, $external);
        usort($merged, static function (Encounter $a, Encounter $b): int {
            if ($a->encounterDate === null && $b->encounterDate === null) {
                return 0;
            }
            if ($a->encounterDate === null) {
                return 1;
            }
            if ($b->encounterDate === null) {
                return -1;
            }
            return $b->encounterDate <=> $a->encounterDate;
        });
        return $merged;
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
