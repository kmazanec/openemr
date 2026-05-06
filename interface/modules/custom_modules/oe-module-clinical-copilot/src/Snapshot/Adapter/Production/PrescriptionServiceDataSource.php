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
 * plus inactive rows whose most recent touch falls within the lookback
 * window from `prescriptions`.
 *
 * `prescriptions.route` and `prescriptions.interval` are heterogeneous:
 * legacy forms write a `list_options.option_id` (numeric); eRx imports
 * write the resolved string. The COALESCE picks the resolved
 * `list_options.title` when the column is a numeric id, otherwise
 * falls back to the raw value. Same approach
 * {@see \OpenEMR\Services\PrescriptionService} takes in its FHIR
 * pipeline.
 *
 * The recency predicate uses `COALESCE(p.date_modified, p.date_added)`
 * because `prescriptions.date_modified` is nullable and many legacy
 * write paths (and the seed pipeline's `markStopped()` helper) leave it
 * unset on the initial INSERT. A bare `p.date_modified >= ?` evaluates
 * NULL as not-true and silently drops every stopped row that was never
 * edited after creation — the exact rows the briefing's "deltas since
 * last visit" surface needs to see. Falling back to `date_added` treats
 * an unmodified row as last touched when it was created.
 *
 * Prescriber name comes from joining `users` on `prescriptions.provider_id`.
 */
final readonly class PrescriptionServiceDataSource implements PrescriptionDataSource
{
    /**
     * Exposed as a constant so isolated tests can pin the recency
     * predicate against accidental regression to the bare
     * `p.date_modified >= ?` form.
     */
    public const RECENT_QUERY_SQL =
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
            AND (p.active = 1 OR COALESCE(p.date_modified, p.date_added) >= ?)
          ORDER BY p.active DESC, p.date_added DESC";

    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        $threshold = (new DateTimeImmutable())
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d H:i:s');

        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            self::RECENT_QUERY_SQL,
            [$pid, $threshold],
        ));
    }
}
