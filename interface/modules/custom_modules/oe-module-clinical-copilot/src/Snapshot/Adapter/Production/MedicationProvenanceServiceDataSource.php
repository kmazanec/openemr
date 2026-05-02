<?php

/**
 * Production-wired {@see MedicationProvenanceDataSource} reading a
 * single prescription row by id, scoped to the patient.
 *
 * Mirrors the JOIN shape from {@see MedicationServiceDataSource} so
 * route/interval/prescriber resolve identically. Does **not** filter
 * `active = 1`: UC3 may ask about a med that was just discontinued.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationProvenanceDataSource;

final readonly class MedicationProvenanceServiceDataSource implements MedicationProvenanceDataSource
{
    public function findByPrescriptionId(int $pid, int $prescriptionId): ?array
    {
        $rows = RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT p.id,
                    p.drug,
                    p.dosage,
                    p.date_added,
                    p.indication,
                    TRIM(CONCAT_WS(' ', users.lname, users.fname)) AS prescriber
               FROM prescriptions p
          LEFT JOIN users
                 ON users.id = p.provider_id
              WHERE p.id = ?
                AND p.patient_id = ?
              LIMIT 1",
            [$prescriptionId, $pid],
        ));
        return $rows[0] ?? null;
    }
}
