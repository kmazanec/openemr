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

use DateTimeImmutable;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentDataSource;

/**
 * Production-wired {@see AppointmentDataSource}.
 *
 * Calendar events store the practitioner as `users.id` (varchar
 * `pc_aid`); the adapter takes a uuid. Convert the uuid to bytes once
 * and JOIN through `users` so the call surface stays uuid-typed.
 *
 * Returns the earliest slot of the day for the (patient, practitioner)
 * tuple — a clinician opening a chart sees the same row UC1's briefing
 * is built around.
 */
final readonly class AppointmentServiceDataSource implements AppointmentDataSource
{
    public function findOnDate(int $pid, string $practitionerUuid, DateTimeImmutable $date): ?array
    {
        $raw = QueryUtils::querySingleRow(
            'SELECT events.pc_eid,
                    events.pc_eventDate,
                    events.pc_startTime,
                    events.pc_duration,
                    cats.pc_catname,
                    events.pc_title
               FROM openemr_postcalendar_events events
               JOIN users
                 ON CAST(users.id AS CHAR) = events.pc_aid
               JOIN openemr_postcalendar_categories cats
                 ON cats.pc_catid = events.pc_catid
              WHERE events.pc_pid = ?
                AND users.uuid = ?
                AND events.pc_eventDate = ?
              ORDER BY events.pc_startTime ASC
              LIMIT 1',
            [
                (string) $pid,
                UuidRegistry::uuidToBytes($practitionerUuid),
                $date->format('Y-m-d'),
            ],
        );
        return $raw === false ? null : RowAssertion::withStringKeys($raw);
    }
}
