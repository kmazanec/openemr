<?php

/**
 * One slot on a practitioner's daily schedule.
 *
 * Distinct from {@see Appointment} (which lives inside a per-patient
 * ChartSnapshot and represents the visit context) — a ScheduleSlot is
 * a top-level list element keyed by the practitioner's day, and
 * carries `pid` so the schedule view can navigate to the chart and
 * the morning-prep job can fan out per patient.
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
 * @phpstan-type ScheduleSlotArray array{
 *     appointmentId: string,
 *     pid: int,
 *     startAt: string,
 *     durationMinutes: int,
 *     type: ?string,
 *     reason: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class ScheduleSlot
{
    public function __construct(
        public string $appointmentId,
        public int $pid,
        public DateTimeImmutable $startAt,
        public int $durationMinutes,
        public ?string $type,
        public ?string $reason,
        public SourceReference $source,
    ) {
    }

    /**
     * @return ScheduleSlotArray
     */
    public function toArray(): array
    {
        return [
            'appointmentId' => $this->appointmentId,
            'pid' => $this->pid,
            'startAt' => $this->startAt->format(\DateTimeInterface::ATOM),
            'durationMinutes' => $this->durationMinutes,
            'type' => $this->type,
            'reason' => $this->reason,
            'source' => $this->source->toArray(),
        ];
    }
}
