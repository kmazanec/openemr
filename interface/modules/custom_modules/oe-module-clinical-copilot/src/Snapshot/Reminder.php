<?php

/**
 * Clinical reminder — overdue or due health-maintenance items.
 *
 * Sourced from OpenEMR's `patient_reminders` table joined to
 * `list_options` for human-readable category/due-status titles. Maps
 * to FHIR `Task` (the reminder's action item is the task; the rule
 * that generated it is the parent CarePlan).
 *
 * The adapter caps and filters at the data layer:
 *   - only `active = 1` rows
 *   - only `due_status` in `('due', 'overdue')` — `not_due_yet` is
 *     informational noise for the briefing surface
 *   - capped at 5 rows, overdue-first then by `date_created` desc
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
 * @phpstan-import-type SourceReferenceArray from SourceReference
 *
 * @phpstan-type ReminderArray array{
 *     item: string,
 *     itemTitle: string,
 *     category: string,
 *     categoryTitle: string,
 *     dueStatus: string,
 *     createdAt: ?string,
 *     reminderId: ?int,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Reminder
{
    public function __construct(
        // Raw `patient_reminders.item` code — maps to a row in
        // `rule_action_item` (e.g. `act_cat_med` for medications).
        public string $item,
        // Human-readable title resolved from `rule_action_item.title`.
        // The verifier matches on this, not on the raw code, so a
        // claim that says "mammogram" is accepted against a row whose
        // `item` is the cryptic seed code.
        public string $itemTitle,
        public string $category,
        public string $categoryTitle,
        // `'due'` | `'overdue'`. The verifier rule requires the claim
        // text to contain this token (case-insensitive) so a claim
        // can't say "due" against an overdue reminder.
        public string $dueStatus,
        public ?DateTimeImmutable $createdAt,
        // Same value the SourceReference carries as `recordId`,
        // surfaced as a top-level int so §4.6.5's reminder-detail
        // branch can address a single reminder without spelunking
        // through the citation. Mirrors the `prescriptionId` pattern.
        public ?int $reminderId,
        public SourceReference $source,
    ) {
    }

    /**
     * @return ReminderArray
     */
    public function toArray(): array
    {
        return [
            'item' => $this->item,
            'itemTitle' => $this->itemTitle,
            'category' => $this->category,
            'categoryTitle' => $this->categoryTitle,
            'dueStatus' => $this->dueStatus,
            'createdAt' => $this->createdAt?->format('Y-m-d'),
            'reminderId' => $this->reminderId,
            'source' => $this->source->toArray(),
        ];
    }
}
