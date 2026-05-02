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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderDataSource;

/**
 * Production-wired {@see ReminderDataSource}. Joins
 * `patient_reminders` to `list_options` for human-readable category
 * and due-status titles, and to `rule_action_item` for the
 * clinician-facing item title.
 *
 * Title resolution falls back to the raw code (LEFT JOINs) so a row
 * whose list_options entry is missing still surfaces — the briefing
 * gets a less polished label rather than disappearing the reminder.
 *
 * Filter posture:
 *   - `pr.active = 1` (skip inactivated reminders)
 *   - `pr.due_status IN ('due', 'overdue')` (skip `not_due_yet` —
 *     informational noise for the briefing)
 *   - ORDER BY due_status='overdue' first, then `date_created` desc
 *
 * Wraps the raw `library/reminders.php::patient_fetch_reminders()`
 * is not used here — that helper does not return the joined titles
 * we need, and routing through it would couple the adapter to a
 * procedural global. Direct query keeps the adapter testable and
 * the result shape stable.
 */
final readonly class ReminderServiceDataSource implements ReminderDataSource
{
    public function findDueForPid(int $pid, int $cap): array
    {
        // The CASE expression in ORDER BY puts overdue rows first
        // (rank 0) before due rows (rank 1) without relying on a
        // string-sort on the due_status column (lexically 'due'
        // sorts before 'overdue', which is the wrong order for
        // surfacing the more urgent items).
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT pr.id,
                    pr.pid,
                    pr.due_status,
                    pr.category,
                    pr.item,
                    pr.date_created,
                    due.title AS due_status_title,
                    cat.title AS category_title,
                    rai.clin_rem_link AS item_title_raw,
                    item_opt.title AS item_title
               FROM patient_reminders pr
          LEFT JOIN list_options AS due
                 ON due.list_id = 'rule_reminder_due_opt'
                AND due.option_id = pr.due_status
          LEFT JOIN list_options AS cat
                 ON cat.list_id = 'rule_action_category'
                AND cat.option_id = pr.category
          LEFT JOIN rule_action_item AS rai
                 ON rai.category = pr.category
                AND rai.item = pr.item
          LEFT JOIN list_options AS item_opt
                 ON item_opt.list_id = 'rule_action'
                AND item_opt.option_id = pr.item
              WHERE pr.pid = ?
                AND pr.active = 1
                AND pr.due_status IN ('due', 'overdue')
              ORDER BY CASE pr.due_status WHEN 'overdue' THEN 0 ELSE 1 END,
                       pr.date_created DESC
              LIMIT ?",
            [$pid, $cap],
        ));
    }
}
