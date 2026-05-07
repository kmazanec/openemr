<?php

/**
 * Boundary between {@see MedicationStatementWriteService} and
 * OpenEMR's `lists` + `lists_medication` tables for a
 * `type='medication'` patient-reported medication row.
 *
 * Two-table writer: a patient-reported medication is one `lists` row
 * (type='medication', title=drug name, source_document_uuid linking
 * back to the intake form) plus one sibling `lists_medication` row
 * carrying the FHIR-MedicationRequest-shaped columns
 * (`drug_dosage_instructions`, `usage_category`, `request_intent`,
 * `is_primary_record=0`, `medication_adherence_information_source =
 * 'patient'`). The writer owns its own boundary so the service stays
 * trivially testable (in-memory implementation in tests; real Doctrine
 * connection in production) and free of SQL strings.
 *
 * Idempotency check is a single read joining `lists` LEFT JOIN
 * `lists_medication` keyed on
 * `(source_document_uuid, type='medication', lower(trim(title)))`. The
 * LEFT JOIN guarantees that an orphaned `lists` row (e.g. an aborted
 * prior insert that committed `lists` but failed `lists_medication`)
 * is still found so the writer doesn't double-insert.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface MedicationStatementListsTableWriter
{
    /**
     * Look up an existing `lists` row that already represents this
     * patient-reported medication (by `(source_document_uuid,
     * type='medication', lower(trim(title)))`). The query LEFT JOINs
     * `lists_medication` so an orphaned `lists` row from a prior
     * partial insert is still found and the writer doesn't
     * double-insert. Returns the canonical UUID + row id if found;
     * null otherwise.
     */
    public function findExistingMedication(
        string $sourceDocumentUuid,
        string $normalizedDrugName,
    ): ?PersistedListEntry;

    /**
     * Insert a `lists` row with `type='medication'` plus a sibling
     * `lists_medication` row under a transaction. Mints a fresh
     * `lists.uuid` (binary) and returns the canonical UUID + row id.
     * Either both rows land or neither — the writer rolls back on any
     * failure between the two inserts.
     */
    public function insertMedication(
        MedicationStatementPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry;
}
