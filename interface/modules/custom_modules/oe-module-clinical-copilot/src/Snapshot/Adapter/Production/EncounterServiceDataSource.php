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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterDataSource;

/**
 * Production-wired {@see EncounterDataSource} reading recent visits
 * from `form_encounter`.
 *
 * Encounter type prefers the human description column when populated
 * (some imports/HL7 carry it); falls back to `class_code` (AMB / IMP /
 * EMER per HL7 v3 ActCode). The adapter further normalizes empty
 * strings to null.
 */
final readonly class EncounterServiceDataSource implements EncounterDataSource
{
    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        $cutoff = (new \DateTimeImmutable('today'))
            ->modify('-' . $lookbackDays . ' days')
            ->format('Y-m-d');

        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT encounter,
                    DATE(`date`) AS encounter_date,
                    COALESCE(NULLIF(encounter_type_description, ''), class_code)
                        AS encounter_type,
                    reason
               FROM form_encounter
              WHERE pid = ?
                AND DATE(`date`) >= ?
              ORDER BY `date` DESC",
            [$pid, $cutoff],
        ));
    }
}
