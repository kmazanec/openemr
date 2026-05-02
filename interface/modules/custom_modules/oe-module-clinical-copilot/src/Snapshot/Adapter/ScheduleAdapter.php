<?php

/**
 * Builds the per-practitioner day schedule used by UC5 morning prep.
 *
 * Parallel to {@see AppointmentAdapter}: same row shape (calendar
 * events store `pc_eventDate` + `pc_startTime` separately and
 * `pc_duration` in seconds, which the adapter assembles into ATOM
 * datetime + duration-in-minutes), but returns a sorted list rather
 * than a single row, and exposes `pid` so the schedule view can
 * navigate to each chart.
 *
 * Defensive on row shape: a row that fails to parse a startAt or
 * lacks a usable pid is dropped rather than emitted as a half-formed
 * slot the LLM would trust.
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
use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ScheduleSlot;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class ScheduleAdapter
{
    public function __construct(
        private ScheduleDataSource $source,
    ) {
    }

    /**
     * @return list<ScheduleSlot> ordered by startAt ascending
     */
    public function fetchSchedule(string $practitionerUuid, DateTimeImmutable $date): array
    {
        $rows = $this->source->findScheduleByPractitioner($practitionerUuid, $date);

        $slots = [];
        foreach ($rows as $row) {
            $slot = self::rowToSlot($row);
            if ($slot !== null) {
                $slots[] = $slot;
            }
        }

        usort($slots, static fn(ScheduleSlot $a, ScheduleSlot $b): int => $a->startAt <=> $b->startAt);

        return $slots;
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function rowToSlot(array $row): ?ScheduleSlot
    {
        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'pc_eid'));
        } catch (DomainException) {
            return null;
        }

        $pid = self::pid($row);
        if ($pid === null) {
            return null;
        }

        $startAt = self::parseStartAt(
            Normalize::stringField($row, 'pc_eventDate'),
            Normalize::stringField($row, 'pc_startTime'),
        );
        if ($startAt === null) {
            return null;
        }

        return new ScheduleSlot(
            appointmentId: $recordId,
            pid: $pid,
            startAt: $startAt,
            durationMinutes: self::durationMinutes($row),
            type: Normalize::toOptionalString(Normalize::stringField($row, 'pc_catname')),
            reason: Normalize::toOptionalString(Normalize::stringField($row, 'pc_title')),
            source: new SourceReference(
                system: 'openemr',
                recordType: 'Appointment',
                recordId: $recordId,
                recordedAt: $startAt,
            ),
        );
    }

    private static function parseStartAt(?string $rawDate, ?string $rawTime): ?DateTimeImmutable
    {
        $date = Normalize::toDateString($rawDate);
        $time = Normalize::toOptionalString($rawTime);
        if ($date === null || $time === null) {
            return null;
        }
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $date . ' ' . $time);
        return $parsed === false ? null : $parsed;
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function pid(array $row): ?int
    {
        $raw = $row['pc_pid'] ?? null;
        if (is_int($raw) && $raw > 0) {
            return $raw;
        }
        if (is_string($raw) && ctype_digit($raw) && (int) $raw > 0) {
            return (int) $raw;
        }
        return null;
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function durationMinutes(array $row): int
    {
        $raw = $row['pc_duration'] ?? 0;
        if (is_int($raw)) {
            return intdiv(max(0, $raw), 60);
        }
        if (is_string($raw) && ctype_digit($raw)) {
            return intdiv((int) $raw, 60);
        }
        return 0;
    }
}
