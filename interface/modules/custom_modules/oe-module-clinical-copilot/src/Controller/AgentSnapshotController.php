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
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
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
        private ClockInterface $clock,
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

        // Read the clock once per request so the appointment-window
        // query and the disclosure event share a single instant.
        $now = $this->clock->now();

        try {
            $snapshot = $this->buildSnapshot($pid, $verified, $categories, $now);
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

        // The disclosure event must land in the regulatory audit trail
        // BEFORE any chart data leaves the boundary. The listener writes
        // extended_log fail-closed: if that throws, we refuse to emit the
        // body. Engineering-side request log failures are absorbed inside
        // the listener and don't reach here.
        try {
            $this->dispatchDisclosure($actor, $verified, $pid, $snapshot, $categories, $conversationId, $now);
        } catch (\RuntimeException | \Doctrine\DBAL\Exception $e) {
            $this->logger->error('Agent snapshot disclosure write failed', [
                'pid' => $pid,
                'exception' => $e,
            ]);
            $this->respondError(503, 'disclosure_unavailable');
            return;
        }

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
            $enumCase = DataCategory::tryFrom($category);
            if ($enumCase === null) {
                return null;
            }
            if (!in_array($enumCase->smartScope(), $verified->scopes, strict: true)) {
                return null;
            }
        }

        return DataCategorySet::fromStrings($categories);
    }

    private function buildSnapshot(
        int $pid,
        VerifiedAgentToken $verified,
        DataCategorySet $categories,
        \DateTimeImmutable $now,
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
                $now,
            );
        }

        // The adapter calls above are already gated by the
        // DataCategorySet — categories the request did not ask for are
        // never fetched, so the snapshot we hand back already reflects
        // exactly the categories named in the disclosure event. See
        // {@see PhiMinimizer} for the demographic-level exclusion pin.
        return new ChartSnapshot(
            patient: $patient,
            appointment: $appointment,
            diagnoses: $diagnoses,
            medications: $medications,
            allergies: $allergies,
            labs: $labs,
            encounters: $encounters,
        );
    }

    private function dispatchDisclosure(
        ResolvedAgentActor $actor,
        VerifiedAgentToken $verified,
        int $pid,
        ChartSnapshot $snapshot,
        DataCategorySet $categories,
        ?string $conversationId,
        \DateTimeImmutable $now,
    ): void {
        $disclosure = new AgentDisclosure(
            disclosedAt: $now,
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
