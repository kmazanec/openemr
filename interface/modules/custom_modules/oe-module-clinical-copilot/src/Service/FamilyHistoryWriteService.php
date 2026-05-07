<?php

/**
 * Tier-3 writer for accepted family-history facts.
 *
 * When a clinician clicks "accept" on an extracted family-history
 * entry in the panel, this service translates the agent middleman's
 * {@see FamilyHistoryPromotionRequest} into a real `lists` row with
 * `type='family_history'` so the entry shows up in the chart's
 * family-history widget, in FHIR `FamilyMemberHistory` reads (when
 * those land), and in any quality / export consumers that listen on
 * {@see \OpenEMR\Modules\ClinicalCopilot\Events\FamilyHistoryListEntryCreatedEvent}.
 *
 * Idempotency is keyed on `(sourceDocumentUuid, normalizedTitle)`,
 * where `title = "{relation} — {condition}"`. A re-call with the same
 * key returns the existing UUID without writing — the panel's accept
 * button can fire once-per-click without needing client-side dedupe,
 * and a network retry that the client believes timed out will
 * reconcile cleanly.
 *
 * Architecture parallel: this is the family-history-side counterpart
 * of {@see AllergyListWriteService} (F.5b). The pattern mirrors
 * allergy's: find-existing → return cached on hit, else insert +
 * dispatch event.
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
use OpenEMR\Modules\ClinicalCopilot\Events\FamilyHistoryListEntryCreatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class FamilyHistoryWriteService
{
    public function __construct(
        private FamilyHistoryListsTableWriter $tableWriter,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function write(FamilyHistoryPromotionRequest $request): FamilyHistoryPromotionResult
    {
        $normalized = $request->normalizedTitle();
        $existing = $this->tableWriter->findExistingFamilyHistory(
            sourceDocumentUuid: $request->sourceDocumentUuid,
            normalizedTitle: $normalized,
        );
        if ($existing !== null) {
            $this->logger->info('Tier-3 family-history promotion idempotent hit', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'listUuid' => $existing->listUuid,
            ]);
            return new FamilyHistoryPromotionResult(
                listUuid: $existing->listUuid,
                idempotentHit: true,
            );
        }

        $createdAt = $this->clock->now();

        try {
            $inserted = $this->tableWriter->insertFamilyHistory($request, $createdAt);
        } catch (\Throwable $e) {
            $this->logger->error('Tier-3 family-history promotion write failed', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Tier-3 family-history promotion write failed', 0, $e);
        }

        $this->eventDispatcher->dispatch(
            new FamilyHistoryListEntryCreatedEvent(
                listUuid: $inserted->listUuid,
                listRowId: $inserted->listRowId,
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                title: $request->title(),
                createdAt: $createdAt,
            ),
            FamilyHistoryListEntryCreatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-3 family-history promotion written', [
            'pid' => $request->pid,
            'sourceDocumentUuid' => $request->sourceDocumentUuid,
            'listUuid' => $inserted->listUuid,
        ]);

        return new FamilyHistoryPromotionResult(
            listUuid: $inserted->listUuid,
            idempotentHit: false,
        );
    }
}
