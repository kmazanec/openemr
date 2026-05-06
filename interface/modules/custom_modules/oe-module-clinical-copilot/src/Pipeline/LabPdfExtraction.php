<?php

/**
 * Lab-PDF extraction DTO. PHP mirror of the Zod schema in
 * `agent/src/pipeline/schemas/labPdf.ts`. Field names + required/
 * optional shape match exactly so a `json_decode` of the agent-persisted
 * Tier-2 `schema_json` round-trips through `fromArray`.
 *
 * Unknown extraction keys are dropped silently here, just as the Zod
 * `.passthrough()` rule discards them on the agent side: the PHP
 * decoder reads the keys it knows and ignores the rest. Required-field
 * absence throws `DomainException` rather than producing a half-built
 * object.
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
 * @phpstan-import-type CitedFieldArray from CitedField
 * @phpstan-import-type Bbox from CitedField
 *
 * @phpstan-type DemographicsArray array{
 *     name: CitedFieldArray,
 *     dob: CitedFieldArray,
 *     sex: CitedFieldArray
 * }
 *
 * @phpstan-type ResultArray array{
 *     panel_code?: ?string,
 *     analyte_name: string,
 *     value: string,
 *     unit: string,
 *     ref_range_low?: ?string,
 *     ref_range_high?: ?string,
 *     abnormal_flag?: ?string,
 *     collection_date: string,
 *     page: int,
 *     bbox: Bbox,
 *     quote: string,
 *     confidence: float
 * }
 *
 * @phpstan-type OrderingProviderArray array{
 *     name: string,
 *     npi?: ?string,
 *     page: int,
 *     bbox: Bbox,
 *     quote: string,
 *     confidence: float
 * }
 *
 * @phpstan-type LabPdfExtractionArray array{
 *     patient_demographics: DemographicsArray,
 *     results: list<ResultArray>,
 *     ordering_provider: OrderingProviderArray
 * }
 */
final readonly class LabPdfExtraction
{
    private const ALLOWED_SEX = ['male', 'female', 'other', 'unknown'];
    private const ALLOWED_ABNORMAL_FLAGS = ['high', 'low', 'critical_high', 'critical_low', 'normal'];

    /**
     * @param list<LabResult> $results
     */
    public function __construct(
        public CitedField $name,
        public CitedField $dob,
        public CitedField $sex,
        public array $results,
        public OrderingProvider $orderingProvider,
    ) {
        if ($results === []) {
            throw new DomainException('LabPdfExtraction.results must contain at least one row');
        }
        if (!in_array($this->sex->value, self::ALLOWED_SEX, true)) {
            throw new DomainException('LabPdfExtraction.patient_demographics.sex.value must be one of male|female|other|unknown');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $demographics = ExtractionFieldDecoder::requireObject($data, 'patient_demographics', 'LabPdfExtraction');
        $name = ExtractionFieldDecoder::requireObject($demographics, 'name', 'LabPdfExtraction.patient_demographics');
        $dob = ExtractionFieldDecoder::requireObject($demographics, 'dob', 'LabPdfExtraction.patient_demographics');
        $sex = ExtractionFieldDecoder::requireObject($demographics, 'sex', 'LabPdfExtraction.patient_demographics');

        $rawResults = $data['results'] ?? null;
        if (!is_array($rawResults)) {
            throw new DomainException('LabPdfExtraction.results must be an array');
        }
        /** @var list<LabResult> $results */
        $results = [];
        foreach ($rawResults as $row) {
            if (!is_array($row)) {
                throw new DomainException('LabPdfExtraction.results entries must be objects');
            }
            /** @var array<string, mixed> $row */
            $results[] = LabResult::fromArray($row);
        }

        $orderingProvider = ExtractionFieldDecoder::requireObject($data, 'ordering_provider', 'LabPdfExtraction');

        return new self(
            name: CitedField::fromArray($name),
            dob: CitedField::fromArray($dob),
            sex: CitedField::fromArray($sex),
            results: $results,
            orderingProvider: OrderingProvider::fromArray($orderingProvider),
        );
    }

    /**
     * @return LabPdfExtractionArray
     */
    public function toArray(): array
    {
        /** @var list<ResultArray> $results */
        $results = array_map(static fn(LabResult $r): array => $r->toArray(), $this->results);
        return [
            'patient_demographics' => [
                'name' => $this->name->toArray(),
                'dob' => $this->dob->toArray(),
                'sex' => $this->sex->toArray(),
            ],
            'results' => $results,
            'ordering_provider' => $this->orderingProvider->toArray(),
        ];
    }

    /**
     * @return list<string>
     */
    public static function allowedAbnormalFlags(): array
    {
        return self::ALLOWED_ABNORMAL_FLAGS;
    }
}
