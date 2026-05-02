<?php

/**
 * Production-wired {@see MedicationStatementProvenanceDataSource}.
 * Reads a single `lists` (`type='medication'`) row joined to
 * `lists_medication` and `list_options` for the
 * information-source title.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementProvenanceDataSource;

final readonly class MedicationStatementProvenanceServiceDataSource implements
    MedicationStatementProvenanceDataSource
{
    public function findByListId(int $pid, int $listId): ?array
    {
        $rows = RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT l.id,
                    l.title,
                    l.begdate,
                    l.enddate,
                    lm.drug_dosage_instructions,
                    lm.usage_category_title,
                    lm.medication_adherence_date_asserted,
                    lm.prescription_id,
                    info_src.title AS information_source_title
               FROM lists l
         INNER JOIN lists_medication lm
                 ON lm.list_id = l.id
          LEFT JOIN list_options AS info_src
                 ON info_src.list_id = 'medication_adherence_information_source'
                AND info_src.option_id = lm.medication_adherence_information_source
              WHERE l.id = ?
                AND l.pid = ?
                AND l.type = 'medication'
              LIMIT 1",
            [$listId, $pid],
        ));
        return $rows[0] ?? null;
    }
}
