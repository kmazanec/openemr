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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleDataSource;

/**
 * Production-wired {@see ScheduleDataSource}.
 *
 * Mirrors {@see AppointmentServiceDataSource}'s JOIN strategy:
 * `pc_aid` is a varchar holding `users.id` as a string, so the JOIN
 * `CAST(users.id AS CHAR) = events.pc_aid` lets the call surface stay
 * uuid-typed. Returns the full day's slots ordered by start time so
 * downstream consumers (the morning-prep job, the schedule view) get a
 * sorted list without re-sorting.
 */
final readonly class ScheduleServiceDataSource implements ScheduleDataSource
{
    public function findScheduleByPractitioner(string $practitionerUuid, DateTimeImmutable $date): array
    {
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            'SELECT events.pc_eid,
                    events.pc_pid,
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
              WHERE users.uuid = ?
                AND events.pc_eventDate = ?
              ORDER BY events.pc_startTime ASC',
            [
                UuidRegistry::uuidToBytes($practitionerUuid),
                $date->format('Y-m-d'),
            ],
        ));
    }
}
