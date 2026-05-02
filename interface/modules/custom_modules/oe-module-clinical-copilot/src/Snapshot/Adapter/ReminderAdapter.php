<?php

/**
 * Builds the active reminder list for a ChartSnapshot.
 *
 * Sourced from `patient_reminders` joined to `list_options` for
 * human-readable category and due-status titles. Filters and cap live
 * in the production data source so the same constraints apply to
 * every consumer (snapshot path + future drill-down endpoints).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Reminder;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class ReminderAdapter
{
    /**
     * Cap on reminders surfaced in a single briefing. A patient with
     * many lapsed screenings could otherwise drown the briefing in a
     * long tail of overdue items; the briefing surface is for "what
     * matters today," not a complete reminder dashboard.
     */
    public const DEFAULT_CAP = 5;

    public function __construct(
        private ReminderDataSource $source,
    ) {
    }

    /**
     * @return list<Reminder>
     */
    public function fetchDue(int $pid, int $cap = self::DEFAULT_CAP): array
    {
        $rows = $this->source->findDueForPid($pid, $cap);
        $out = [];
        foreach ($rows as $row) {
            $reminder = $this->mapRow($row);
            if ($reminder !== null) {
                $out[] = $reminder;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?Reminder
    {
        $item = Normalize::toOptionalString(Normalize::stringField($row, 'item'));
        if ($item === null) {
            return null;
        }
        $dueStatus = Normalize::toOptionalString(Normalize::stringField($row, 'due_status'));
        if ($dueStatus === null) {
            return null;
        }

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        // Title fields fall back to the raw code when the
        // list_options join misses (seeded data sometimes carries
        // codes with no list_options row). The verifier matches
        // case-insensitively on `itemTitle`, so even a raw-code
        // fallback still grounds claims that mention the code.
        $itemTitle = Normalize::toOptionalString(Normalize::stringField($row, 'item_title')) ?? $item;
        $category = Normalize::toOptionalString(Normalize::stringField($row, 'category')) ?? '';
        $categoryTitle = Normalize::toOptionalString(Normalize::stringField($row, 'category_title')) ?? $category;
        $dueStatusTitle = Normalize::toOptionalString(Normalize::stringField($row, 'due_status_title'))
            ?? $dueStatus;

        $createdAt = Normalize::toDateImmutable(Normalize::stringField($row, 'date_created'));

        return new Reminder(
            item: $item,
            itemTitle: $itemTitle,
            category: $category,
            categoryTitle: $categoryTitle,
            dueStatus: $dueStatusTitle,
            createdAt: $createdAt,
            reminderId: (int) $recordId,
            source: new SourceReference(
                system: 'openemr',
                recordType: 'Task',
                recordId: $recordId,
                recordedAt: $createdAt,
            ),
        );
    }
}
