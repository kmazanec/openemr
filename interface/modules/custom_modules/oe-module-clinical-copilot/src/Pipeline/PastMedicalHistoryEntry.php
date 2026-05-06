<?php

/**
 * One past-medical-history entry on an intake form. Mirrors
 * `pastMedicalHistoryEntrySchema` in
 * `agent/src/pipeline/schemas/intakeForm.ts`.
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
 * @phpstan-import-type PastMedicalHistoryArray from IntakeFormExtraction
 */
final readonly class PastMedicalHistoryEntry
{
    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public string $condition,
        public ?string $onsetYear,
        public ?string $notes,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->condition === '') {
            throw new DomainException('PastMedicalHistoryEntry.condition must be non-empty');
        }
        if ($this->page <= 0) {
            throw new DomainException('PastMedicalHistoryEntry.page must be positive');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('PastMedicalHistoryEntry.confidence must be in [0, 1]');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $condition = ExtractionFieldDecoder::requireString($data, 'condition', 'PastMedicalHistoryEntry');
        return new self(
            condition: $condition,
            onsetYear: ExtractionFieldDecoder::optionalString($data, 'onset_year', 'PastMedicalHistoryEntry'),
            notes: ExtractionFieldDecoder::optionalString($data, 'notes', 'PastMedicalHistoryEntry'),
            page: ExtractionFieldDecoder::requireInt($data, 'page', 'PastMedicalHistoryEntry'),
            bbox: ExtractionFieldDecoder::requireBbox($data, 'PastMedicalHistoryEntry'),
            quote: ExtractionFieldDecoder::requireString($data, 'quote', 'PastMedicalHistoryEntry'),
            confidence: ExtractionFieldDecoder::requireConfidence($data, 'PastMedicalHistoryEntry'),
        );
    }

    /**
     * @return PastMedicalHistoryArray
     */
    public function toArray(): array
    {
        $out = [
            'condition' => $this->condition,
            'page' => $this->page,
            'bbox' => $this->bbox,
            'quote' => $this->quote,
            'confidence' => $this->confidence,
        ];
        if ($this->onsetYear !== null) {
            $out['onset_year'] = $this->onsetYear;
        }
        if ($this->notes !== null) {
            $out['notes'] = $this->notes;
        }
        return $out;
    }
}
