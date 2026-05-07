<?php

/**
 * Tier-3 writer for accepted patient-reported-medication facts.
 *
 * When a clinician clicks "accept" on an extracted medication entry in
 * the panel, this service translates the agent middleman's
 * {@see MedicationStatementPromotionRequest} into a real `lists` row
 * (type='medication') plus a sibling `lists_medication` row flagged as
 * a reported (not primary) record so the medication shows up in the
 * chart's medication widget, in FHIR `MedicationStatement` reads, and
 * in any quality / export consumers that listen on
 * {@see \OpenEMR\Modules\ClinicalCopilot\Events\MedicationStatementListEntryCreatedEvent}.
 *
 * The "patient-reported" framing is what distinguishes this writer
 * from the prescription-table flow: stock OpenEMR's
 * `prescriptions` table is the authoritative ordered/filled
 * medication source, while `lists`/`lists_medication` with
 * `is_primary_record=0` and
 * `medication_adherence_information_source='patient'` is the
 * MedicationStatement-shaped surface for what the patient says they
 * are taking. Intake-form extraction lands here.
 *
 * Idempotency is keyed on
 * `(sourceDocumentUuid, normalizedDrugName)`. A re-call with the same
 * key returns the existing UUID without writing — the panel's accept
 * button can fire once-per-click without needing client-side dedupe,
 * and a network retry that the client believes timed out will
 * reconcile cleanly.
 *
 * Architecture parallel: this is the medication-side counterpart of
 * {@see AllergyListWriteService}, with the only structural difference
 * being the two-table insert (vs. allergy's single-table insert)
 * which is the table writer's responsibility.
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
use OpenEMR\Modules\ClinicalCopilot\Events\MedicationStatementListEntryCreatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class MedicationStatementWriteService
{
    public function __construct(
        private MedicationStatementListsTableWriter $tableWriter,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function write(MedicationStatementPromotionRequest $request): MedicationStatementPromotionResult
    {
        $normalized = $request->normalizedDrugName();
        $existing = $this->tableWriter->findExistingMedication(
            sourceDocumentUuid: $request->sourceDocumentUuid,
            normalizedDrugName: $normalized,
        );
        if ($existing !== null) {
            $this->logger->info('Tier-3 medication_statement promotion idempotent hit', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'listUuid' => $existing->listUuid,
            ]);
            return new MedicationStatementPromotionResult(
                listUuid: $existing->listUuid,
                idempotentHit: true,
            );
        }

        $createdAt = $this->clock->now();

        try {
            $inserted = $this->tableWriter->insertMedication($request, $createdAt);
        } catch (\Throwable $e) {
            $this->logger->error('Tier-3 medication_statement promotion write failed', [
                'pid' => $request->pid,
                'sourceDocumentUuid' => $request->sourceDocumentUuid,
                'exception' => $e,
            ]);
            throw new \RuntimeException(
                'Tier-3 medication_statement promotion write failed',
                0,
                $e,
            );
        }

        $this->eventDispatcher->dispatch(
            new MedicationStatementListEntryCreatedEvent(
                listUuid: $inserted->listUuid,
                listRowId: $inserted->listRowId,
                pid: $request->pid,
                sourceDocumentUuid: $request->sourceDocumentUuid,
                drugName: $request->drugName,
                createdAt: $createdAt,
            ),
            MedicationStatementListEntryCreatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-3 medication_statement promotion written', [
            'pid' => $request->pid,
            'sourceDocumentUuid' => $request->sourceDocumentUuid,
            'listUuid' => $inserted->listUuid,
        ]);

        return new MedicationStatementPromotionResult(
            listUuid: $inserted->listUuid,
            idempotentHit: false,
        );
    }
}
