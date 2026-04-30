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

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentActorResolver;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenVerificationException;
use OpenEMR\Modules\ClinicalCopilot\Auth\OpenEmrJwtVerifier;
use OpenEMR\Modules\ClinicalCopilot\Auth\ResolvedAgentActor;
use OpenEMR\Modules\ClinicalCopilot\Auth\VerifiedAgentToken;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ChartSnapshot;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategory;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategorySet;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\PhiMinimizer;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

/**
 * Agent-callback snapshot endpoint.
 *
 * Trust direction: the **Node agent** authenticates with the JWT we
 * already minted in {@see AgentTokenMinter} and calls back to fetch
 * chart data. The browser never hits this endpoint.
 *
 * Defense in depth (every check is a hard reject):
 *   1. JWT signature/claims via {@see OpenEmrJwtVerifier}
 *   2. fhirUser claim resolves to a Practitioner-eligible role
 *   3. ACL re-check against the resolved username for `patients.demo`
 *   4. Every requested category maps to a scope the JWT carries
 *
 * On success: builds a {@see ChartSnapshot} through every adapter,
 * applies {@see PhiMinimizer}, dispatches exactly one
 * {@see AgentDisclosedEvent}, and returns the snapshot as JSON.
 */
final readonly class AgentSnapshotController
{
    private const DEFAULT_LOOKBACK_DAYS = 365;

    /**
     * Maps each {@see DataCategory} to the SMART scope that authorizes
     * it. The agent's JWT must carry the matching scope for any
     * category it asks for; missing scope → 403.
     *
     * @var array<string, string>
     */
    private const CATEGORY_SCOPE = [
        'diagnosis' => 'user/Condition.rs',
        'medication' => 'user/MedicationRequest.rs',
        'allergy' => 'user/AllergyIntolerance.rs',
        'lab' => 'user/Observation.rs',
        'encounter' => 'user/Encounter.rs',
        'appointment' => 'user/Appointment.rs',
    ];

    public function __construct(
        private OpenEmrJwtVerifier $verifier,
        private AgentActorResolver $actorResolver,
        private PatientAdapter $patientAdapter,
        private ConditionAdapter $conditionAdapter,
        private MedicationAdapter $medicationAdapter,
        private AllergyAdapter $allergyAdapter,
        private ObservationAdapter $observationAdapter,
        private EncounterAdapter $encounterAdapter,
        private AppointmentAdapter $appointmentAdapter,
        private EventDispatcherInterface $eventDispatcher,
        private LoggerInterface $logger,
        private string $siteId,
        private \DateTimeImmutable $now,
    ) {
    }

    /**
     * Handle a snapshot request. Writes the JSON response or an error
     * envelope to PHP's output stream and sets the HTTP status code.
     *
     * @param ?list<string> $requestedCategories Null = "all categories";
     *        an array filters to those plus their guarding scopes.
     */
    public function handle(
        ?string $bearerToken,
        ?int $pid,
        ?array $requestedCategories,
        ?string $conversationId,
    ): void {
        if ($bearerToken === null || $bearerToken === '') {
            $this->respondError(401, 'missing_token');
            return;
        }

        try {
            $verified = $this->verifier->verify($bearerToken);
        } catch (AgentTokenVerificationException $e) {
            $this->logger->warning('Agent snapshot token rejected', [
                'reason' => $e->getMessage(),
                'siteId' => $this->siteId,
            ]);
            $this->respondError(401, 'invalid_token');
            return;
        }

        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        $actor = $this->actorResolver->resolve($verified->subject);
        if ($actor === null) {
            $this->logger->warning('Agent snapshot fhirUser unresolved', [
                'sub' => $verified->subject,
            ]);
            $this->respondError(403, 'fhir_user_unresolved');
            return;
        }

        // ACL re-check: even though the proxy ran PolicyGate before
        // minting the JWT, the agent could be calling back through a
        // path that bypassed the proxy. Repeat the patient-access
        // check explicitly per ARCHITECTURE.md §"Repeat explicit
        // checks at agent endpoints".
        if (!$this->actorResolver->mayReadPatients($actor)) {
            $this->logger->warning('Agent snapshot ACL denied', [
                'sub' => $verified->subject,
            ]);
            $this->respondError(403, 'acl_denied');
            return;
        }

        $categories = $this->resolveCategorySet($verified, $requestedCategories);
        if ($categories === null) {
            $this->respondError(403, 'scope_not_permitted');
            return;
        }

        try {
            $snapshot = $this->buildSnapshot($pid, $verified, $categories);
        } catch (\RuntimeException | \DomainException | \Doctrine\DBAL\Exception $e) {
            // Narrow catch (CLAUDE.md ForbiddenCatchTypeRule). RuntimeException
            // covers PatientAdapter's missing-row case + adapter fail-closed
            // throws; DomainException covers DataCategorySet construction;
            // DBAL exception covers data-source query failures.
            $this->logger->error('Agent snapshot build failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'snapshot_unavailable');
            return;
        }

        $this->dispatchDisclosure($actor, $verified, $pid, $snapshot, $categories, $conversationId);
        $this->respondJson(200, $snapshot->toArray());
    }

    /**
     * @param ?list<string> $requestedCategories
     */
    private function resolveCategorySet(
        VerifiedAgentToken $verified,
        ?array $requestedCategories,
    ): ?DataCategorySet {
        $categories = $requestedCategories ?? array_map(
            static fn(DataCategory $c): string => $c->value,
            DataCategory::cases(),
        );

        foreach ($categories as $category) {
            $scope = self::CATEGORY_SCOPE[$category] ?? null;
            if ($scope === null) {
                return null;
            }
            if (!in_array($scope, $verified->scopes, strict: true)) {
                return null;
            }
        }

        return DataCategorySet::fromStrings($categories);
    }

    private function buildSnapshot(
        int $pid,
        VerifiedAgentToken $verified,
        DataCategorySet $categories,
    ): ChartSnapshot {
        $patient = $this->patientAdapter->fetch($pid);

        $diagnoses = $categories->contains(DataCategory::Diagnosis)
            ? $this->conditionAdapter->fetchActive($pid)
            : [];
        $medications = $categories->contains(DataCategory::Medication)
            ? $this->medicationAdapter->fetchActive($pid)
            : [];
        $allergies = $categories->contains(DataCategory::Allergy)
            ? $this->allergyAdapter->fetchActive($pid)
            : [];
        $labs = $categories->contains(DataCategory::Lab)
            ? $this->observationAdapter->fetchRecent($pid, self::DEFAULT_LOOKBACK_DAYS)
            : [];
        $encounters = $categories->contains(DataCategory::Encounter)
            ? $this->encounterAdapter->fetchRecent($pid, self::DEFAULT_LOOKBACK_DAYS)
            : [];

        $appointment = null;
        if ($categories->contains(DataCategory::Appointment)) {
            $appointment = $this->appointmentAdapter->fetchToday(
                $pid,
                $verified->subject,
                $this->now,
            );
        }

        $snapshot = new ChartSnapshot(
            patient: $patient,
            appointment: $appointment,
            diagnoses: $diagnoses,
            medications: $medications,
            allergies: $allergies,
            labs: $labs,
            encounters: $encounters,
        );

        // PhiMinimizer is the documentation pin: the categories chosen
        // here are the categories the disclosure event will name. The
        // adapters above already gated by category, so this call is
        // primarily contract enforcement (and protection against an
        // adapter that surfaces a category-bound DTO it shouldn't).
        return (new PhiMinimizer())->withCategories($snapshot, $categories);
    }

    private function dispatchDisclosure(
        ResolvedAgentActor $actor,
        VerifiedAgentToken $verified,
        int $pid,
        ChartSnapshot $snapshot,
        DataCategorySet $categories,
        ?string $conversationId,
    ): void {
        $disclosure = new AgentDisclosure(
            disclosedAt: $this->now,
            actorUserId: $actor->userId,
            actorFhirUser: $verified->fhirUser,
            siteId: $this->siteId,
            patientPid: $pid,
            patientUuid: $snapshot->patient->uuid,
            conversationId: $conversationId,
            action: 'snapshot',
            requestId: $verified->jti,
            categories: $categories->toStrings(),
            destination: $verified->audience,
        );
        $this->eventDispatcher->dispatch(
            new AgentDisclosedEvent($disclosure),
            AgentDisclosedEvent::EVENT_HANDLE,
        );
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
