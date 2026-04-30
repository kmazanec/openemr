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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationDataSource;

/**
 * Production-wired {@see ObservationDataSource} reading lab results
 * from `procedure_result` joined back through `procedure_report` →
 * `procedure_order`.
 *
 * Uses `procedure_report.date_report` (the lab-stamped result date) as
 * the observation timestamp. Falls back to `date_collected`, then to
 * `procedure_order.date_ordered` if both are null. Lookback compares
 * against the most-likely-populated of those.
 */
final readonly class ObservationServiceDataSource implements ObservationDataSource
{
    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        $cutoff = (new \DateTimeImmutable('today'))
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d');

        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT pr.procedure_result_id AS id,
                    pr.result_text AS analyte,
                    pr.result AS value,
                    pr.units,
                    pr.`range`,
                    pr.abnormal,
                    DATE(COALESCE(prep.date_report, prep.date_collected, po.date_ordered))
                        AS observed_at
               FROM procedure_result pr
               JOIN procedure_report prep
                 ON prep.procedure_report_id = pr.procedure_report_id
               JOIN procedure_order po
                 ON po.procedure_order_id = prep.procedure_order_id
              WHERE po.patient_id = ?
                AND po.activity = 1
                AND DATE(COALESCE(prep.date_report, prep.date_collected, po.date_ordered)) >= ?
              ORDER BY observed_at DESC",
            [$pid, $cutoff],
        ));
    }
}
