<?php

/**
 * Boundary between {@see PatientDemographicsWriteService} and
 * OpenEMR's standard demographics-update path
 * ({@see \OpenEMR\Services\PatientService}, ultimately the
 * `patient_data` table).
 *
 * Unlike the F.5b–F.5e `lists`-row writers, demographics promotion
 * doesn't mint a new chart record — it updates an existing
 * `patient_data` column in place. The boundary owns two operations:
 *
 *   - {@see fetchSnapshot()}: read back the patient's UUID + the
 *     current column value so the service can no-op when the chart
 *     already matches the incoming delta and still surface the
 *     patient UUID for disclosure linking. This is the "natural"
 *     idempotency check for demographics — there's no
 *     `source_document_uuid` column on `patient_data` (F.1's column
 *     was added only to `lists`), so we compare the value itself
 *     rather than a tracking row.
 *
 *   - {@see updateField()}: route the per-field write through the
 *     standard {@see \OpenEMR\Services\PatientService::databaseUpdate}
 *     surface so the existing audit-log + `BeforePatientUpdatedEvent` /
 *     `PatientUpdatedEvent` listeners fire as if a clinician edited
 *     the form. Returns the patient's UUID (string form) so the
 *     service can return it to the controller for disclosure-event
 *     linking.
 *
 * The service treats `field` as a typed {@see DemographicsField} enum
 * so the writer never receives a stringly-typed column name. The enum
 * → column mapping lives on the enum itself
 * ({@see DemographicsField::patientDataColumn()}), which keeps the
 * production writer free of dispatch logic and the test double trivially
 * simple.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface PatientDemographicsTableWriter
{
    /**
     * Read back the patient's UUID + the current value of the
     * `patient_data` column the given `DemographicsField` writes to.
     * The service uses the value to no-op when it already matches
     * the requested delta, and the UUID to link the disclosure
     * event regardless of which path the service takes.
     *
     * Empty-string column values (the OpenEMR schema's `''` sentinel
     * for "not set") are normalized to `null` so the service's
     * idempotency check is symmetric with "no value yet."
     *
     * Returns `null` when the patient does not exist.
     */
    public function fetchSnapshot(int $pid, DemographicsField $field): ?PatientDemographicsSnapshot;

    /**
     * Update the `patient_data` column for `$pid` to `$value` through
     * OpenEMR's standard demographics-update path so the existing
     * audit-log + patient-updated listeners fire. Returns the
     * patient's UUID (string form) — the service uses it to link the
     * `AgentDisclosedEvent` back to the chart record.
     *
     * Throws {@see \RuntimeException} if the patient does not exist
     * or the underlying update fails (the service wraps and re-throws
     * with PSR-3 context).
     */
    public function updateField(
        int $pid,
        DemographicsField $field,
        string $value,
        int $promotedByUserId,
        \DateTimeImmutable $updatedAt,
    ): string;
}
