<?php

/**
 * Production-wired {@see ReminderDetailDataSource} reading a single
 * `patient_reminders` row by id, scoped to the patient. Mirrors the
 * JOIN shape from {@see ReminderServiceDataSource} so titles resolve
 * identically. Adds a join to `clinical_rules` for the rule
 * description (the §4.6.5 branch's main "why is this due?" payload).
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderDetailDataSource;

final readonly class ReminderDetailServiceDataSource implements ReminderDetailDataSource
{
    public function findByReminderId(int $pid, int $reminderId): ?array
    {
        $rows = RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT pr.id,
                    pr.pid,
                    pr.due_status,
                    pr.category,
                    pr.item,
                    pr.date_created,
                    due.title AS due_status_title,
                    cat.title AS category_title,
                    item_opt.title AS item_title,
                    cr.rule_desc AS rule_description
               FROM patient_reminders pr
          LEFT JOIN list_options AS due
                 ON due.list_id = 'rule_reminder_due_opt'
                AND due.option_id = pr.due_status
          LEFT JOIN list_options AS cat
                 ON cat.list_id = 'rule_action_category'
                AND cat.option_id = pr.category
          LEFT JOIN list_options AS item_opt
                 ON item_opt.list_id = 'rule_action'
                AND item_opt.option_id = pr.item
          LEFT JOIN clinical_rules AS cr
                 ON cr.id = pr.category
                AND cr.pid = 0
              WHERE pr.id = ?
                AND pr.pid = ?
              LIMIT 1",
            [$reminderId, $pid],
        ));
        return $rows[0] ?? null;
    }
}
