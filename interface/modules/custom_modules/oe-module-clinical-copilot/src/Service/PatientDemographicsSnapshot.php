<?php

/**
 * Pair returned by {@see PatientDemographicsTableWriter::fetchSnapshot()}.
 * The patient's UUID (string form) plus the current value of the
 * `patient_data` column the {@see DemographicsField} maps to.
 *
 * Returned as a pair so the service can both compare-for-idempotency
 * and link the disclosure event to the patient UUID without making
 * two round-trips when the chart already matches the requested value.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

final readonly class PatientDemographicsSnapshot
{
    public function __construct(
        public string $patientUuid,
        public ?string $currentValue,
    ) {
    }
}
