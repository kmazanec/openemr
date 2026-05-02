<?php

/**
 * Data-source seam for {@see ReminderAdapter}.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface ReminderDataSource
{
    /**
     * Active, due-or-overdue reminders for a patient. The cap is
     * applied at the data layer so the adapter (and the briefing it
     * feeds) can't drown a clinician in a long tail of lapsed
     * screenings.
     *
     * @return list<array<string, mixed>>
     */
    public function findDueForPid(int $pid, int $cap): array;
}
