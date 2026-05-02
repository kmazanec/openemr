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

use DateTimeImmutable;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionDataSource;

/**
 * Production-wired {@see PrescriptionDataSource} reading active rows
 * plus inactive rows modified within the lookback window from
 * `prescriptions`.
 *
 * `prescriptions.route` and `prescriptions.interval` are heterogeneous:
 * legacy forms write a `list_options.option_id` (numeric); eRx imports
 * write the resolved string. The COALESCE picks the resolved
 * `list_options.title` when the column is a numeric id, otherwise
 * falls back to the raw value. Same approach
 * {@see \OpenEMR\Services\PrescriptionService} takes in its FHIR
 * pipeline.
 *
 * Prescriber name comes from joining `users` on `prescriptions.provider_id`.
 */
final readonly class PrescriptionServiceDataSource implements PrescriptionDataSource
{
    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        $threshold = (new DateTimeImmutable())
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d H:i:s');

        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT p.id,
                    p.drug,
                    p.dosage,
                    p.active,
                    COALESCE(routes.title, p.route) AS route_title,
                    COALESCE(intervals.title, p.note) AS interval_title,
                    p.date_added,
                    p.date_modified,
                    p.indication,
                    TRIM(CONCAT_WS(' ', users.lname, users.fname)) AS prescriber
               FROM prescriptions p
          LEFT JOIN list_options AS routes
                 ON routes.list_id = 'drug_route'
                AND routes.option_id = p.route
          LEFT JOIN list_options AS intervals
                 ON intervals.list_id = 'drug_interval'
                AND intervals.option_id = p.`interval`
          LEFT JOIN users
                 ON users.id = p.provider_id
              WHERE p.patient_id = ?
                AND (p.active = 1 OR p.date_modified >= ?)
              ORDER BY p.active DESC, p.date_added DESC",
            [$pid, $threshold],
        ));
    }
}
