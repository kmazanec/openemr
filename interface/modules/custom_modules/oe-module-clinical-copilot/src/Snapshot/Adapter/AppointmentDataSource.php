<?php

/**
 * Data-source seam for AppointmentAdapter.
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

interface AppointmentDataSource
{
    /**
     * @return ?array<string, mixed> the appointment row, or null if no
     *   appointment exists for this (patient, practitioner, date) tuple
     */
    public function findOnDate(int $pid, string $practitionerUuid, DateTimeImmutable $date): ?array;
}
