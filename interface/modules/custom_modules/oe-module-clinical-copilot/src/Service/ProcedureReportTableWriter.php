<?php

/**
 * Boundary between {@see ObservationLabWriteService} and OpenEMR's
 * `procedure_order` / `procedure_order_code` / `procedure_report` /
 * `procedure_result` tables.
 *
 * The lab-promotion writer needs four-tier write coordination because
 * OpenEMR models a lab panel as:
 *
 *   procedure_order (per patient + provider)
 *     → procedure_order_code (per panel inside the order)
 *       → procedure_report (per lab-result panel; carries source_document_uuid)
 *         → procedure_result (per analyte row)
 *
 * Splitting this surface out of DBAL keeps the service trivially
 * testable (in-memory implementation in tests; real DBAL connection
 * in production) and keeps the service free of SQL strings. The
 * implementation owns the transaction: a half-written panel is worse
 * than a re-promote, so all four inserts (order, order-code, report,
 * results) commit together or roll back together.
 *
 * Idempotency check is a single read against `procedure_report` keyed
 * on `(source_document_uuid, panel_code, collection_date)`. The
 * implementation returns the existing row's IDs on hit; the service
 * skips the writes and returns those IDs to the caller.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface ProcedureReportTableWriter
{
    /**
     * Look up an existing `procedure_report` row by the W2 idempotency
     * key. Returns null if no row matches; otherwise returns the
     * canonical UUID of the report and the canonical UUIDs of every
     * `procedure_result` row that hangs off it (in stable order).
     */
    public function findExistingPanel(
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
    ): ?PersistedProcedureReport;

    /**
     * Insert the four-row chain (`procedure_order`,
     * `procedure_order_code`, `procedure_report`, one
     * `procedure_result` per analyte) under one transaction. Returns
     * the freshly-minted UUIDs and row IDs the service needs to fire
     * the post-insert event and respond to the caller.
     *
     * @param non-empty-list<ObservationResult> $results
     * @return PersistedProcedureReport
     */
    public function insertPanel(
        int $pid,
        string $sourceDocumentUuid,
        ?string $panelCode,
        string $collectionDate,
        array $results,
        int $promotedByUserId,
        \DateTimeImmutable $createdAt,
    ): PersistedProcedureReport;
}
