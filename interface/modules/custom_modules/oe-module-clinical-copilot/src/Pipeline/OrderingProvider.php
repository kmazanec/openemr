<?php

/**
 * Ordering provider line on a lab PDF. Mirrors `orderingProviderSchema`
 * in `agent/src/pipeline/schemas/labPdf.ts`.
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
 * @phpstan-import-type OrderingProviderArray from LabPdfExtraction
 */
final readonly class OrderingProvider
{
    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public string $name,
        public ?string $npi,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->name === '') {
            throw new DomainException('OrderingProvider.name must be non-empty');
        }
        if ($this->page <= 0) {
            throw new DomainException('OrderingProvider.page must be positive');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('OrderingProvider.confidence must be in [0, 1]');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            name: ExtractionFieldDecoder::requireString($data, 'name', 'OrderingProvider'),
            npi: ExtractionFieldDecoder::optionalString($data, 'npi', 'OrderingProvider'),
            page: ExtractionFieldDecoder::requireInt($data, 'page', 'OrderingProvider'),
            bbox: ExtractionFieldDecoder::requireBbox($data, 'OrderingProvider'),
            quote: ExtractionFieldDecoder::requireString($data, 'quote', 'OrderingProvider'),
            confidence: ExtractionFieldDecoder::requireConfidence($data, 'OrderingProvider'),
        );
    }

    /**
     * @return OrderingProviderArray
     */
    public function toArray(): array
    {
        $out = [
            'name' => $this->name,
            'page' => $this->page,
            'bbox' => $this->bbox,
            'quote' => $this->quote,
            'confidence' => $this->confidence,
        ];
        if ($this->npi !== null) {
            $out['npi'] = $this->npi;
        }
        return $out;
    }
}
