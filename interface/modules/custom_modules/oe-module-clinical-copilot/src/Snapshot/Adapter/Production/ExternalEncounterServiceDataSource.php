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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterDataSource;

/**
 * Production-wired {@see ExternalEncounterDataSource} reading outside-
 * care visits from `external_encounters`.
 *
 * Column aliases mirror {@see EncounterServiceDataSource}'s row shape so
 * the adapter can reuse the same `mapRow` logic. `ee_facility_id` is the
 * closest analogue to a native encounter type — the seed pipeline emits
 * facility names (e.g. "St. Mary ED") and CCDA imports populate it from
 * the document's documenter/author. `ee_external_id` is the upstream
 * system's identifier; `ee_id` is the local primary key the adapter
 * cites as `recordId`.
 */
final readonly class ExternalEncounterServiceDataSource implements ExternalEncounterDataSource
{
    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        $cutoff = (new \DateTimeImmutable('today'))
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d');

        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT ee_id AS encounter,
                    ee_date AS encounter_date,
                    ee_facility_id AS encounter_type,
                    ee_encounter_diagnosis AS reason
               FROM external_encounters
              WHERE ee_pid = ?
                AND ee_date >= ?
              ORDER BY ee_date DESC",
            [$pid, $cutoff],
        ));
    }
}
