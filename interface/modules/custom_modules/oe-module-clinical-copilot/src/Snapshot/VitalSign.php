<?php

/**
 * Single vital-sign reading taken at one point in time.
 *
 * Mirrors the row shape of `form_vitals` after normalization. Numeric
 * fields are preserved as strings for the same reason `LabObservation`
 * does — qualifiers (`<10`, `>200`) and source-side rounding survive
 * round-trips, and the verifier compares displayed claim text against
 * the source value.
 *
 * Each reading carries up to nine analytes (BP systolic/diastolic,
 * pulse, respiration, temperature, weight, height, BMI, oxygen
 * saturation). Null means the lab/clinic did not record that field for
 * this reading; downstream consumers must distinguish "missing" from
 * "abnormal".
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
 * @phpstan-type VitalSignArray array{
 *     observedAt: ?string,
 *     bpSystolic: ?string,
 *     bpDiastolic: ?string,
 *     pulse: ?string,
 *     respiration: ?string,
 *     temperatureF: ?string,
 *     weightLbs: ?string,
 *     heightInches: ?string,
 *     bmi: ?string,
 *     oxygenSaturation: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class VitalSign
{
    public function __construct(
        public ?DateTimeImmutable $observedAt,
        public ?string $bpSystolic,
        public ?string $bpDiastolic,
        public ?string $pulse,
        public ?string $respiration,
        public ?string $temperatureF,
        public ?string $weightLbs,
        public ?string $heightInches,
        public ?string $bmi,
        public ?string $oxygenSaturation,
        public SourceReference $source,
    ) {
    }

    /**
     * @return VitalSignArray
     */
    public function toArray(): array
    {
        return [
            'observedAt' => $this->observedAt?->format('Y-m-d'),
            'bpSystolic' => $this->bpSystolic,
            'bpDiastolic' => $this->bpDiastolic,
            'pulse' => $this->pulse,
            'respiration' => $this->respiration,
            'temperatureF' => $this->temperatureF,
            'weightLbs' => $this->weightLbs,
            'heightInches' => $this->heightInches,
            'bmi' => $this->bmi,
            'oxygenSaturation' => $this->oxygenSaturation,
            'source' => $this->source->toArray(),
        ];
    }
}
