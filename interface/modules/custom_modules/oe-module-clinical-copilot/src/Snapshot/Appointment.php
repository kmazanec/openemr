<?php

/**
 * Appointment context for the current visit (UC1) or a scheduled one (UC5).
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
 * @phpstan-type AppointmentArray array{
 *     appointmentId: string,
 *     startAt: string,
 *     durationMinutes: int,
 *     type: ?string,
 *     reason: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Appointment
{
    public function __construct(
        public string $appointmentId,
        public DateTimeImmutable $startAt,
        public int $durationMinutes,
        public ?string $type,
        public ?string $reason,
        public SourceReference $source,
    ) {
    }

    /**
     * @return AppointmentArray
     */
    public function toArray(): array
    {
        return [
            'appointmentId' => $this->appointmentId,
            'startAt' => $this->startAt->format(\DateTimeInterface::ATOM),
            'durationMinutes' => $this->durationMinutes,
            'type' => $this->type,
            'reason' => $this->reason,
            'source' => $this->source->toArray(),
        ];
    }
}
