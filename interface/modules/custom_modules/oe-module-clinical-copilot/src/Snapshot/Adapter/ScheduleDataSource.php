<?php

/**
 * Data-source seam for ScheduleAdapter.
 *
 * Separate from {@see AppointmentDataSource} on purpose: that interface
 * answers "what is the today-slot for this (patient, practitioner)
 * tuple inside a ChartSnapshot"; this one answers "what is the full
 * day's schedule for this practitioner". Different shape, different
 * caller, different SQL — keeping them apart avoids forcing every
 * existing AppointmentDataSource impl to grow a stub method.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use DateTimeImmutable;

interface ScheduleDataSource
{
    /**
     * @return list<array<string, mixed>> raw appointment rows for the
     *   given practitioner on the given date, ordered by start time
     *   ascending. Empty list if no appointments are scheduled.
     */
    public function findScheduleByPractitioner(string $practitionerUuid, DateTimeImmutable $date): array;
}
