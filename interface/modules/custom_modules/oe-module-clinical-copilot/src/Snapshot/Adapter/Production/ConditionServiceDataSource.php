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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionDataSource;

/**
 * Production-wired {@see ConditionDataSource} reading active problems
 * from the legacy `lists` table. The ConditionAdapter parses
 * `lists.diagnosis` (`ICD10:E11.9`, `ICD9:250.00`, etc.) — we just
 * project the columns it needs and let it normalize.
 *
 * "Active" = `enddate` is null or empty (legacy schema uses `''` and
 * `'0000-00-00'` for "still active").
 */
final readonly class ConditionServiceDataSource implements ConditionDataSource
{
    public function findActiveForPid(int $pid): array
    {
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT id, diagnosis, title, `date`
               FROM lists
              WHERE pid = ?
                AND type = 'medical_problem'
                AND (enddate IS NULL OR enddate = '' OR enddate = '0000-00-00')",
            [$pid],
        ));
    }
}
