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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Narrow agent endpoint that returns the "who is this patient" bundle:
 * demographics, active diagnoses, and active allergies. The model
 * picks this tool when a follow-up needs identity context without the
 * full chart.
 *
 * Bundling three categories into one tool / one endpoint is a
 * deliberate exception to the "one category per tool" rule —
 * demographics + diagnoses + allergies are the things a clinician
 * thinks of as "the patient" rather than "a stream of records".
 * Splitting them would force the model to make three calls for the
 * common case. The bundling stops here: nothing else multiplexes.
 *
 * The endpoint requires *all three* SMART scopes
 * (`user/Condition.rs`, `user/AllergyIntolerance.rs`,
 * `user/Patient.rs`) — a token missing any one fails 403
 * `scope_not_permitted`.
 *
 * Audit row carries `action='patient_context'`.
 */
final readonly class PatientContextController
{
    public function __construct(
        private AgentEndpointAuth $auth,
        private PatientAdapter $patientAdapter,
        private ConditionAdapter $conditionAdapter,
        private AllergyAdapter $allergyAdapter,
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
        // Patient identity has no SMART scope of its own (it's the
        // request's trust anchor) so we gate on the two clinical
        // scopes that the bundle exposes, and check both.
        $request = $this->auth->authorize($bearerToken, 'user/Condition.rs');
        if ($request === null) {
            return;
        }
        if (!in_array('user/AllergyIntolerance.rs', $request->verified->scopes, strict: true)) {
            $this->respondError(403, 'scope_not_permitted');
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        try {
            $patient = $this->patientAdapter->fetch($pid);
            $diagnoses = $this->conditionAdapter->fetchActive($pid);
            $allergies = $this->allergyAdapter->fetchActive($pid);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent patient-context fetch failed', [
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
                    patientUuid: $patient->uuid,
                    conversationId: $conversationId,
                    action: 'patient_context',
                    requestId: $request->verified->jti,
                    categories: ['allergy', 'diagnosis'],
                    destination: $request->verified->audience,
                )),
                AgentDisclosedEvent::EVENT_HANDLE,
            );
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent patient-context disclosure write failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

        $this->respondJson(200, [
            'patient' => $patient->toArray(),
            'diagnoses' => array_map(static fn($d) => $d->toArray(), $diagnoses),
            'allergies' => array_map(static fn($a) => $a->toArray(), $allergies),
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
