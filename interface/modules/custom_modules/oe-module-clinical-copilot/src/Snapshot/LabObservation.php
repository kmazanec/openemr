<?php

/**
 * Lab observation line for a ChartSnapshot.
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
 * `value` is a string so it can carry trailing/leading text from the
 * source (`>500`, `<0.01`, `positive`) without coercion. The adapter is
 * responsible for normalizing what it can.
 *
 * @phpstan-import-type SourceReferenceArray from SourceReference
 *
 * @phpstan-type LabObservationArray array{
 *     analyte: string,
 *     value: string,
 *     unit: ?string,
 *     referenceRange: ?string,
 *     abnormalFlag: ?string,
 *     observedAt: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class LabObservation
{
    public function __construct(
        public string $analyte,
        public string $value,
        public ?string $unit,
        public ?string $referenceRange,
        public ?string $abnormalFlag,
        public ?DateTimeImmutable $observedAt,
        public SourceReference $source,
    ) {
    }

    /**
     * @return LabObservationArray
     */
    public function toArray(): array
    {
        return [
            'analyte' => $this->analyte,
            'value' => $this->value,
            'unit' => $this->unit,
            'referenceRange' => $this->referenceRange,
            'abnormalFlag' => $this->abnormalFlag,
            'observedAt' => $this->observedAt?->format('Y-m-d'),
            'source' => $this->source->toArray(),
        ];
    }
}
