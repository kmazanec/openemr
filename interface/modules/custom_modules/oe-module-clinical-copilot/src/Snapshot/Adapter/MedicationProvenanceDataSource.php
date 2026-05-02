<?php

/**
 * Data-source seam for {@see MedicationProvenanceAdapter}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface MedicationProvenanceDataSource
{
    /**
     * Look up a single prescription by id, scoped to the patient. The pid
     * scope is defense-in-depth: a leaked or guessed prescription id from
     * a different patient must never resolve here.
     *
     * @return array<string, mixed>|null
     */
    public function findByPrescriptionId(int $pid, int $prescriptionId): ?array;
}
