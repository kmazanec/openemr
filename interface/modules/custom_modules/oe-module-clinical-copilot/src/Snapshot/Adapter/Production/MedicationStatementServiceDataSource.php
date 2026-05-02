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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementDataSource;

/**
 * Production-wired {@see MedicationStatementDataSource}. Reads
 * patient-reported medication rows from `lists` (`type='medication'`)
 * joined to `lists_medication` (`is_primary_record=0`).
 *
 * `lists_medication.usage_category_title` and `request_intent_title`
 * are denormalized in the table itself, so no list_options join is
 * needed for those. The information-source title DOES require a join
 * — `medication_adherence_information_source` is just an option_id.
 *
 * Filter posture:
 *   - `lists.type = 'medication'` (the lists table holds many types)
 *   - `lists.activity = 1` (skip ended OTC entries)
 *   - `lists_medication.is_primary_record = 0` (the
 *     MedicationStatement filter — primary records belong to the
 *     prescription side)
 */
final readonly class MedicationStatementServiceDataSource implements MedicationStatementDataSource
{
    public function findActiveForPid(int $pid): array
    {
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT l.id,
                    l.title,
                    l.begdate,
                    l.enddate,
                    l.date,
                    lm.drug_dosage_instructions,
                    lm.usage_category_title,
                    info_src.title AS information_source_title
               FROM lists l
         INNER JOIN lists_medication lm
                 ON lm.list_id = l.id
          LEFT JOIN list_options AS info_src
                 ON info_src.list_id = 'medication_adherence_information_source'
                AND info_src.option_id = lm.medication_adherence_information_source
              WHERE l.pid = ?
                AND l.type = 'medication'
                AND l.activity = 1
                AND lm.is_primary_record = 0
              ORDER BY l.date DESC",
            [$pid],
        ));
    }
}
