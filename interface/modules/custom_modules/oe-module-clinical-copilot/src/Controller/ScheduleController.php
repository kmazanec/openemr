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

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentEndpointAuth;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ScheduleSlot;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns a practitioner's day schedule.
 *
 * Maps 1:1 to the Node-side `getTodaysSchedule` tool (added in §5.3)
 * and to the morning-prep precompute job. Distinct from
 * {@see EncountersController} et al. in that it is keyed by
 * (practitioner, date) rather than (patient) — the response is a list
 * of slots, each carrying its own `pid` so callers can fan out per
 * chart.
 *
 * Audit: the existing `AgentDisclosure` shape requires `patientPid`,
 * so we emit **one disclosure row per slot** rather than one row per
 * fetch. That gives compliance a per-patient audit trail (which is the
 * shape the existing audit consumers already assume) and trivially
 * yields zero rows on empty schedules — important for §5's
 * "zero tokens, zero rows" cost story when morning-prep is disabled.
 */
final readonly class ScheduleController
{
    private const UUID_REGEX = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    public function __construct(
        private AgentEndpointAuth $auth,
        private ScheduleAdapter $adapter,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private ClockInterface $clock,
    ) {
    }

    public function handle(
        ?string $bearerToken,
        ?string $practitionerUuid,
        ?string $dateIso,
        ?string $conversationId,
    ): void {
        $request = $this->auth->authorize($bearerToken, 'user/Appointment.rs');
        if ($request === null) {
            return;
        }

        if ($practitionerUuid === null || $practitionerUuid === '') {
            $this->respondError(400, 'missing_practitioner');
            return;
        }
        if (preg_match(self::UUID_REGEX, $practitionerUuid) !== 1) {
            $this->respondError(400, 'invalid_practitioner');
            return;
        }

        if ($dateIso === null || $dateIso === '') {
            $this->respondError(400, 'missing_date');
            return;
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $dateIso);
        if ($date === false || $date->format('Y-m-d') !== $dateIso) {
            $this->respondError(400, 'invalid_date');
            return;
        }

        try {
            $slots = $this->adapter->fetchSchedule($practitionerUuid, $date);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent schedule fetch failed', [
                'practitioner' => $practitionerUuid,
                'date' => $dateIso,
                'exception' => $e,
            ]);
            $this->respondError(503, 'snapshot_unavailable');
            return;
        }

        $now = $this->clock->now();
        try {
            foreach ($slots as $slot) {
                $this->eventDispatcher->dispatch(
                    new AgentDisclosedEvent(new AgentDisclosure(
                        disclosedAt: $now,
                        actorUserId: $request->actor->userId,
                        actorFhirUser: $request->verified->fhirUser,
                        siteId: $this->siteId,
                        patientPid: $slot->pid,
                        patientUuid: null,
                        conversationId: $conversationId,
                        action: 'schedule',
                        requestId: $request->verified->jti . ':' . $slot->appointmentId,
                        categories: ['appointment'],
                        destination: $request->verified->audience,
                    )),
                    AgentDisclosedEvent::EVENT_HANDLE,
                );
            }
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent schedule disclosure write failed', [
                'practitioner' => $practitionerUuid,
                'date' => $dateIso,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'schedule' => array_map(static fn(ScheduleSlot $s): array => $s->toArray(), $slots),
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
