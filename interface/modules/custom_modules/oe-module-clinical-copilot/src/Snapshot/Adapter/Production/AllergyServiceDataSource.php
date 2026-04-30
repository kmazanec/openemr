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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyDataSource;

/**
 * Production-wired {@see AllergyDataSource}.
 *
 * The reaction column on `lists` is an `option_id` into `list_options`
 * (`list_id = 'reaction'`); the AllergyAdapter expects the resolved
 * label as `reaction_title`. Same JOIN
 * {@see \OpenEMR\Services\AllergyIntoleranceService} runs.
 */
final readonly class AllergyServiceDataSource implements AllergyDataSource
{
    public function findActiveForPid(int $pid): array
    {
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT lists.id,
                    lists.title,
                    lists.`date`,
                    reaction.title AS reaction_title,
                    lists.severity_al
               FROM lists
          LEFT JOIN list_options AS reaction
                 ON reaction.option_id = lists.reaction
                AND reaction.list_id = 'reaction'
              WHERE lists.pid = ?
                AND lists.type = 'allergy'
                AND (lists.enddate IS NULL OR lists.enddate = '' OR lists.enddate = '0000-00-00')",
            [$pid],
        ));
    }
}
