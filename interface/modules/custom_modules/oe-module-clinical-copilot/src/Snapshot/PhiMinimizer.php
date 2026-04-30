<?php

/**
 * Drops chart-snapshot slices the request did not ask for.
 *
 * The §2.2 adapters already exclude SSN, full street address, phone,
 * email, and other sensitive demographic fields at the DTO level —
 * they're not carried into ChartSnapshot in the first place. This
 * minimizer adds the second layer: even among the categories the DTOs
 * do carry (diagnoses, meds, allergies, labs, encounters, appointment),
 * each request only sees the subset its envelope declared.
 *
 * Patient identity is always carried — it is the trust anchor and
 * disclosure-audit key.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

final class PhiMinimizer
{
    /**
     * Demographic-level fields that ARCHITECTURE.md §"ChartSnapshot >
     * Excluded by default" forbids from the snapshot. Pinned here as a
     * structural test target — Demographics::toArray() must not carry
     * any of these keys, and PatientAdapter must never read them. The
     * names use the column shapes a future contributor would reach for
     * in OpenEMR's `patient_data` table, so the test catches drive-by
     * widening.
     *
     * @var list<string>
     */
    public const EXCLUDED_FROM_DEMOGRAPHICS = [
        'ssn',
        'drivers_license',
        'street',
        'phone_home',
        'phone_cell',
        'phone_biz',
        'email',
        'pubpid',
        'billing',
        'occupation',
        'employer',
        'mothersname',
        'next_of_kin',
        'guardian',
    ];

    public function withCategories(ChartSnapshot $snapshot, DataCategorySet $allowed): ChartSnapshot
    {
        return new ChartSnapshot(
            patient: $snapshot->patient,
            appointment: $allowed->contains(DataCategory::Appointment) ? $snapshot->appointment : null,
            diagnoses: $allowed->contains(DataCategory::Diagnosis) ? $snapshot->diagnoses : [],
            medications: $allowed->contains(DataCategory::Medication) ? $snapshot->medications : [],
            allergies: $allowed->contains(DataCategory::Allergy) ? $snapshot->allergies : [],
            labs: $allowed->contains(DataCategory::Lab) ? $snapshot->labs : [],
            encounters: $allowed->contains(DataCategory::Encounter) ? $snapshot->encounters : [],
        );
    }
}
