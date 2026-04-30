<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientDataSource;

/**
 * Production-wired {@see PatientDataSource} that reads `patient_data`
 * directly via {@see QueryUtils} with a narrow projection.
 *
 * The narrow projection is the security contract: SSN, full address,
 * phone, email, and other PHI columns the {@see PatientAdapter}
 * deliberately drops never leave the database. PRESEARCH §5 + the
 * adapter's `testNeverIncludesPhiFromExcludedColumns` test pin this
 * shape.
 */
final readonly class PatientServiceDataSource implements PatientDataSource
{
    public function findByPid(int $pid): ?array
    {
        $raw = QueryUtils::querySingleRow(
            'SELECT pid, uuid, fname, lname, mname, sex, DOB FROM patient_data WHERE pid = ? LIMIT 1',
            [$pid],
        );
        if ($raw === false) {
            return null;
        }

        $row = RowAssertion::withStringKeys($raw);
        // OpenEMR stores uuid as raw bytes; the adapter expects a string.
        if (isset($row['uuid']) && is_string($row['uuid']) && $row['uuid'] !== '') {
            $row['uuid'] = UuidRegistry::uuidToString($row['uuid']);
        }

        return $row;
    }
}
