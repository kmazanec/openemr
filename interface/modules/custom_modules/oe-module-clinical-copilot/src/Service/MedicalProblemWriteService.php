<?php

/**
 * Tier-3 writer for accepted past-medical-history facts.
 *
 * When a clinician clicks "accept" on an extracted past-medical-history
 * entry in the panel, this service translates the agent middleman's
 * {@see MedicalProblemPromotionRequest} into a real `lists` row with
 * `type='medical_problem'` so the condition shows up in the chart's
 * problem list, in FHIR `Condition` reads, and in any quality / export
 * consumers that listen on
 * {@see \OpenEMR\Modules\ClinicalCopilot\Events\MedicalProblemListEntryCreatedEvent}.
 *
 * Idempotency is keyed on `(sourceDocumentUuid, normalizedTitle)`. A
 * re-call with the same key returns the existing UUID without
 * writing — the panel's accept button can fire once-per-click without
 * needing client-side dedupe, and a network retry that the client
 * believes timed out will reconcile cleanly.
 *
 * Architecture parallel: this is the medical-problem-side counterpart
 * of {@see AllergyListWriteService}. The pattern mirrors allergy's:
 * find-existing → return cached on hit, else insert + dispatch event.
 * Single-table like allergy (unlike F.5c's medication_statement which
 * needs a two-table transaction).
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
use OpenEMR\Modules\ClinicalCopilot\Events\MedicalProblemListEntryCreatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class MedicalProblemWriteService
{
    public function __construct(
        private MedicalProblemListsTableWriter $tableWriter,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function write(MedicalProblemPromotionRequest $request): MedicalProblemPromotionResult
    {
        $normalized = $request->normalizedTitle();
        $existing = $this->tableWriter->findExistingMedicalProblem(
            sourceDocumentUuid: $request->sourceDocumentUuid,
            normalizedTitle: $normalized,
        );
        if ($existing !== null) {
            $this->logger->info('Tier-3 medical-problem promotion idempotent hit', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'listUuid' => $existing->listUuid,
            ]);
            return new MedicalProblemPromotionResult(
                listUuid: $existing->listUuid,
                idempotentHit: true,
            );
        }

        $createdAt = $this->clock->now();

        try {
            $inserted = $this->tableWriter->insertMedicalProblem($request, $createdAt);
        } catch (\Throwable $e) {
            $this->logger->error('Tier-3 medical-problem promotion write failed', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Tier-3 medical-problem promotion write failed', 0, $e);
        }

        $this->eventDispatcher->dispatch(
            new MedicalProblemListEntryCreatedEvent(
                listUuid: $inserted->listUuid,
                listRowId: $inserted->listRowId,
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                title: $request->title,
                createdAt: $createdAt,
            ),
            MedicalProblemListEntryCreatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-3 medical-problem promotion written', [
            'pid' => $request->pid,
            'sourceDocumentUuid' => $request->sourceDocumentUuid,
            'listUuid' => $inserted->listUuid,
        ]);

        return new MedicalProblemPromotionResult(
            listUuid: $inserted->listUuid,
            idempotentHit: false,
        );
    }
}
