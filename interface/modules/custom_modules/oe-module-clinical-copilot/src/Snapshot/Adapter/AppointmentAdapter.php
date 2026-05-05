<?php

/**
 * Builds the today-slot Appointment for a ChartSnapshot.
 *
 * OpenEMR stores `pc_eventDate` (date) and `pc_startTime` (HH:MM:SS)
 * separately and `pc_duration` in seconds. The adapter assembles them
 * into a single ISO-8601 datetime and converts duration to minutes —
 * matching the shape the LLM and the UI consume.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Appointment;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class AppointmentAdapter
{
    public function __construct(
        private AppointmentDataSource $source,
    ) {
    }

    public function fetchToday(int $pid, string $practitionerUuid, DateTimeImmutable $today): ?Appointment
    {
        $row = $this->source->findOnDate($pid, $practitionerUuid, $today);
        if ($row === null) {
            return null;
        }

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'pc_eid'));
        } catch (DomainException) {
            return null;
        }

        $startAt = self::parseStartAt(
            Normalize::stringField($row, 'pc_eventDate'),
            Normalize::stringField($row, 'pc_startTime'),
        );
        if ($startAt === null) {
            return null;
        }

        return new Appointment(
            appointmentId: $recordId,
            startAt: $startAt,
            durationMinutes: self::durationMinutes($row),
            type: Normalize::toOptionalString(Normalize::stringField($row, 'pc_catname')),
            reason: Normalize::toOptionalString(Normalize::stringField($row, 'pc_title')),
            source: new SourceReference(
                sourceType: 'chart',
                sourceId: $recordId,
                locator: ['field' => 'appointment.start'],
                quote: $startAt->format('Y-m-d H:i'),
                meta: ['record_recorded_at' => $startAt->format('Y-m-d')],
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
