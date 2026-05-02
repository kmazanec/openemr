<?php

/**
 * Builds a single {@see ReminderDetail} from a `patient_reminders` row.
 *
 * Used by the §4.6.5 reminder-detail branch's narrow tool. Returns
 * null when the reminder doesn't exist for this patient — the
 * controller surfaces that as a 404 so the branch can render a
 * "no record found" connector segment rather than a fabricated
 * answer.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ReminderDetail;

final readonly class ReminderDetailAdapter
{
    public function __construct(
        private ReminderDetailDataSource $source,
    ) {
    }

    public function fetchByPid(int $pid, int $reminderId): ?ReminderDetail
    {
        $row = $this->source->findByReminderId($pid, $reminderId);
        if ($row === null) {
            return null;
        }
        return $this->mapRow($row, $reminderId);
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row, int $reminderId): ?ReminderDetail
    {
        $item = Normalize::toOptionalString(Normalize::stringField($row, 'item'));
        if ($item === null) {
            return null;
        }
        $dueStatus = Normalize::toOptionalString(Normalize::stringField($row, 'due_status'));
        if ($dueStatus === null) {
            return null;
        }
        $itemTitle = Normalize::toOptionalString(Normalize::stringField($row, 'item_title')) ?? $item;
        $category = Normalize::toOptionalString(Normalize::stringField($row, 'category')) ?? '';
        $categoryTitle = Normalize::toOptionalString(Normalize::stringField($row, 'category_title')) ?? $category;
        $dueStatusTitle = Normalize::toOptionalString(Normalize::stringField($row, 'due_status_title'))
            ?? $dueStatus;

        return new ReminderDetail(
            reminderId: $reminderId,
            item: $item,
            itemTitle: $itemTitle,
            category: $category,
            categoryTitle: $categoryTitle,
            dueStatus: $dueStatusTitle,
            createdAt: Normalize::toDateImmutable(Normalize::stringField($row, 'date_created')),
            ruleDescription: Normalize::toOptionalString(
                Normalize::stringField($row, 'rule_description'),
            ),
        );
    }
}
