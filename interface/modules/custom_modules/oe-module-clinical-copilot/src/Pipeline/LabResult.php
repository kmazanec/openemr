<?php

/**
 * One row of a lab-result panel. Mirrors the `resultSchema` in
 * `agent/src/pipeline/schemas/labPdf.ts`.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Pipeline;

use DomainException;

/**
 * @phpstan-import-type Bbox from CitedField
 * @phpstan-import-type ResultArray from LabPdfExtraction
 */
final readonly class LabResult
{
    private const ALLOWED_ABNORMAL_FLAGS = ['high', 'low', 'critical_high', 'critical_low', 'normal'];

    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public ?string $panelCode,
        public string $analyteName,
        public string $value,
        public string $unit,
        public ?string $refRangeLow,
        public ?string $refRangeHigh,
        public ?string $abnormalFlag,
        public string $collectionDate,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->analyteName === '') {
            throw new DomainException('LabResult.analyte_name must be non-empty');
        }
        if ($this->value === '') {
            throw new DomainException('LabResult.value must be non-empty');
        }
        if ($this->unit === '') {
            throw new DomainException('LabResult.unit must be non-empty');
        }
        if ($this->collectionDate === '') {
            throw new DomainException('LabResult.collection_date must be non-empty');
        }
        if ($this->page <= 0) {
            throw new DomainException('LabResult.page must be positive');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('LabResult.confidence must be in [0, 1]');
        }
        if ($this->abnormalFlag !== null && !in_array($this->abnormalFlag, self::ALLOWED_ABNORMAL_FLAGS, true)) {
            throw new DomainException('LabResult.abnormal_flag must be one of high|low|critical_high|critical_low|normal');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            panelCode: ExtractionFieldDecoder::optionalString($data, 'panel_code', 'LabResult'),
            analyteName: ExtractionFieldDecoder::requireString($data, 'analyte_name', 'LabResult'),
            value: ExtractionFieldDecoder::requireString($data, 'value', 'LabResult'),
            unit: ExtractionFieldDecoder::requireString($data, 'unit', 'LabResult'),
            refRangeLow: ExtractionFieldDecoder::optionalString($data, 'ref_range_low', 'LabResult'),
            refRangeHigh: ExtractionFieldDecoder::optionalString($data, 'ref_range_high', 'LabResult'),
            abnormalFlag: ExtractionFieldDecoder::optionalString($data, 'abnormal_flag', 'LabResult'),
            collectionDate: ExtractionFieldDecoder::requireString($data, 'collection_date', 'LabResult'),
            page: ExtractionFieldDecoder::requireInt($data, 'page', 'LabResult'),
            bbox: ExtractionFieldDecoder::requireBbox($data, 'LabResult'),
            quote: ExtractionFieldDecoder::requireString($data, 'quote', 'LabResult'),
            confidence: ExtractionFieldDecoder::requireConfidence($data, 'LabResult'),
        );
    }

    /**
     * @return ResultArray
     */
    public function toArray(): array
    {
        $out = [
            'analyte_name' => $this->analyteName,
            'value' => $this->value,
            'unit' => $this->unit,
            'collection_date' => $this->collectionDate,
            'page' => $this->page,
            'bbox' => $this->bbox,
            'quote' => $this->quote,
            'confidence' => $this->confidence,
        ];
        if ($this->panelCode !== null) {
            $out['panel_code'] = $this->panelCode;
        }
        if ($this->refRangeLow !== null) {
            $out['ref_range_low'] = $this->refRangeLow;
        }
        if ($this->refRangeHigh !== null) {
            $out['ref_range_high'] = $this->refRangeHigh;
        }
        if ($this->abnormalFlag !== null) {
            $out['abnormal_flag'] = $this->abnormalFlag;
        }
        return $out;
    }
}
