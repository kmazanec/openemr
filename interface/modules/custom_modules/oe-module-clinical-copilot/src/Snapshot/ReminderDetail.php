<?php

/**
 * Detailed view of a single clinical reminder for §4.6.5's
 * reminder-detail drill-down. Returns the reminder's rule
 * description (from `rule_action_item`) so the deterministic
 * `reminderBranch` can build a "When is X due?" answer that cites
 * the rule, not just the reminder row.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;

/**
 * @phpstan-type ReminderDetailArray array{
 *     reminderId: int,
 *     item: string,
 *     itemTitle: string,
 *     category: string,
 *     categoryTitle: string,
 *     dueStatus: string,
 *     createdAt: ?string,
 *     ruleDescription: ?string,
 * }
 */
final readonly class ReminderDetail
{
    public function __construct(
        public int $reminderId,
        public string $item,
        public string $itemTitle,
        public string $category,
        public string $categoryTitle,
        public string $dueStatus,
        public ?DateTimeImmutable $createdAt,
        // Resolved title from `rule_action_item.clin_rem_link` or the
        // associated `clinical_rules` row — gives the briefing a
        // human-readable description of *why* the reminder fires
        // ("Annual mammogram screening per USPSTF B"), not just the
        // item code.
        public ?string $ruleDescription,
    ) {
    }

    /**
     * @return ReminderDetailArray
     */
    public function toArray(): array
    {
        return [
            'reminderId' => $this->reminderId,
            'item' => $this->item,
            'itemTitle' => $this->itemTitle,
            'category' => $this->category,
            'categoryTitle' => $this->categoryTitle,
            'dueStatus' => $this->dueStatus,
            'createdAt' => $this->createdAt?->format('Y-m-d'),
            'ruleDescription' => $this->ruleDescription,
        ];
    }
}
