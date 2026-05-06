<?php

/**
 * Single analyte row inside a {@see LabPromotionRequest}. The shape
 * mirrors the W2 lab-PDF extraction's `LabResult` (see
 * `agent/src/pipeline/schemas/labPdf.ts`) trimmed to the fields a
 * Tier-3 promotion actually writes — bbox/quote/page are extraction
 * provenance, not chart data, so they are not part of the chart-write
 * request.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use DomainException;

final readonly class ObservationResult
{
    private const ALLOWED_ABNORMAL_FLAGS = ['high', 'low', 'critical_high', 'critical_low', 'normal'];

    public function __construct(
        public string $analyteName,
        public string $value,
        public string $unit,
        public ?string $refRangeLow,
        public ?string $refRangeHigh,
        public ?string $abnormalFlag,
    ) {
        if ($this->analyteName === '') {
            throw new DomainException('ObservationResult.analyteName must be non-empty');
        }
        if ($this->value === '') {
            throw new DomainException('ObservationResult.value must be non-empty');
        }
        if ($this->unit === '') {
            throw new DomainException('ObservationResult.unit must be non-empty');
        }
        if ($this->abnormalFlag !== null && !in_array($this->abnormalFlag, self::ALLOWED_ABNORMAL_FLAGS, true)) {
            throw new DomainException(
                'ObservationResult.abnormalFlag must be one of high|low|critical_high|critical_low|normal',
            );
        }
    }
}
