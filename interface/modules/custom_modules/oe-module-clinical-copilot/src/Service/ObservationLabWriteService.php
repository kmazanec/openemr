<?php

/**
 * Tier-3 writer for accepted lab panels.
 *
 * When a clinician clicks "accept" on an extracted lab value in the
 * panel, this service translates the agent's
 * {@see LabPromotionRequest} into a real `procedure_report` (panel)
 * plus per-result `procedure_result` rows so the lab shows up in the
 * chart UI, in lab-history reads, and in any quality/export
 * consumers that listen on
 * {@see \OpenEMR\Modules\ClinicalCopilot\Events\ProcedureReportCreatedEvent}.
 *
 * Idempotency is keyed on
 * `(source_document_uuid, panel_code, collection_date)`. A re-call
 * with the same key returns the existing IDs without writing — the
 * Tier-3 promotion control in the panel can fire once-per-click
 * without needing client-side dedupe, and a network retry that the
 * client believes timed out will reconcile cleanly. The hit/miss
 * outcome is exposed on {@see LabPromotionResult::idempotentHit} so
 * callers can log the path; it is never an error.
 *
 * Architecture parallel: this is the lab-side counterpart of
 * {@see DocumentReferenceWriteService}. The Tier-1 Spaces pointer
 * write fires {@see DocumentReferenceCreatedEvent}; the Tier-3 chart
 * write fires {@see ProcedureReportCreatedEvent}. Both stand in for
 * Symfony events stock OpenEMR doesn't ship.
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
use OpenEMR\Modules\ClinicalCopilot\Events\ProcedureReportCreatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class ObservationLabWriteService
{
    public function __construct(
        private ProcedureReportTableWriter $tableWriter,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function write(LabPromotionRequest $request): LabPromotionResult
    {
        $existing = $this->tableWriter->findExistingPanel(
            sourceDocumentUuid: $request->sourceDocumentUuid,
            panelCode: $request->panelCode,
            collectionDate: $request->collectionDate,
        );
        if ($existing !== null) {
            $this->logger->info('Tier-3 lab promotion idempotent hit', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'panelCode' => $request->panelCode,
                'collectionDate' => $request->collectionDate,
                'procedureReportUuid' => $existing->procedureReportUuid,
            ]);
            return new LabPromotionResult(
                diagnosticReportUuid: $existing->procedureReportUuid,
                observationUuids: $existing->observationUuids,
                idempotentHit: true,
            );
        }

        $createdAt = $this->clock->now();

        try {
            $inserted = $this->tableWriter->insertPanel(
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                panelCode: $request->panelCode,
                collectionDate: $request->collectionDate,
                results: $request->results,
                promotedByUserId: $request->promotedByUserId,
                createdAt: $createdAt,
            );
        } catch (\Throwable $e) {
            $this->logger->error('Tier-3 lab promotion write failed', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'panelCode' => $request->panelCode,
                'collectionDate' => $request->collectionDate,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Tier-3 lab promotion write failed', 0, $e);
        }

        $this->eventDispatcher->dispatch(
            new ProcedureReportCreatedEvent(
                procedureReportUuid: $inserted->procedureReportUuid,
                procedureReportRowId: $inserted->procedureReportRowId,
                observationUuids: $inserted->observationUuids,
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                panelCode: $request->panelCode,
                collectionDate: $request->collectionDate,
                createdAt: $createdAt,
            ),
            ProcedureReportCreatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-3 lab promotion written', [
            'pid' => $request->pid,
            'sourceDocumentUuid' => $request->sourceDocumentUuid,
            'panelCode' => $request->panelCode,
            'collectionDate' => $request->collectionDate,
            'procedureReportUuid' => $inserted->procedureReportUuid,
            'analyteCount' => count($inserted->observationUuids),
        ]);

        return new LabPromotionResult(
            diagnosticReportUuid: $inserted->procedureReportUuid,
            observationUuids: $inserted->observationUuids,
            idempotentHit: false,
        );
    }
}
