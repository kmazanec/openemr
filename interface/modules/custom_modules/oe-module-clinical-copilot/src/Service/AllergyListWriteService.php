<?php

/**
 * Tier-3 writer for accepted allergy facts.
 *
 * When a clinician clicks "accept" on an extracted allergy entry in
 * the panel, this service translates the agent middleman's
 * {@see AllergyPromotionRequest} into a real `lists` row with
 * `type='allergy'` so the allergy shows up in the chart's allergy
 * widget, in FHIR `AllergyIntolerance` reads, and in any quality /
 * export consumers that listen on
 * {@see \OpenEMR\Modules\ClinicalCopilot\Events\AllergyListEntryCreatedEvent}.
 *
 * Idempotency is keyed on
 * `(sourceDocumentUuid, normalizedSubstance)`. A re-call with the
 * same key returns the existing UUID without writing — the panel's
 * accept button can fire once-per-click without needing client-side
 * dedupe, and a network retry that the client believes timed out
 * will reconcile cleanly.
 *
 * Architecture parallel: this is the allergy-side counterpart of
 * {@see ObservationLabWriteService}. The pattern mirrors lab's:
 * find-existing → return cached on hit, else insert + dispatch event.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Events\AllergyListEntryCreatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class AllergyListWriteService
{
    public function __construct(
        private AllergyListsTableWriter $tableWriter,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function write(AllergyPromotionRequest $request): AllergyPromotionResult
    {
        $normalized = $request->normalizedSubstance();
        $existing = $this->tableWriter->findExistingAllergy(
            sourceDocumentUuid: $request->sourceDocumentUuid,
            normalizedSubstance: $normalized,
        );
        if ($existing !== null) {
            $this->logger->info('Tier-3 allergy promotion idempotent hit', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'listUuid' => $existing->listUuid,
            ]);
            return new AllergyPromotionResult(
                listUuid: $existing->listUuid,
                idempotentHit: true,
            );
        }

        $createdAt = $this->clock->now();

        try {
            $inserted = $this->tableWriter->insertAllergy($request, $createdAt);
        } catch (\Throwable $e) {
            $this->logger->error('Tier-3 allergy promotion write failed', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Tier-3 allergy promotion write failed', 0, $e);
        }

        $this->eventDispatcher->dispatch(
            new AllergyListEntryCreatedEvent(
                listUuid: $inserted->listUuid,
                listRowId: $inserted->listRowId,
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                substance: $request->substance,
                createdAt: $createdAt,
            ),
            AllergyListEntryCreatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-3 allergy promotion written', [
            'pid' => $request->pid,
            'sourceDocumentUuid' => $request->sourceDocumentUuid,
            'listUuid' => $inserted->listUuid,
        ]);

        return new AllergyPromotionResult(
            listUuid: $inserted->listUuid,
            idempotentHit: false,
        );
    }
}
