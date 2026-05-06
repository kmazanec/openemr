<?php

/**
 * One family-history entry on an intake form. Mirrors
 * `familyHistoryEntrySchema` in
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
 * @phpstan-import-type FamilyHistoryArray from IntakeFormExtraction
 */
final readonly class FamilyHistoryEntry
{
    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public string $relation,
        public string $condition,
        public ?string $notes,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->relation === '') {
            throw new DomainException('FamilyHistoryEntry.relation must be non-empty');
        }
        if ($this->condition === '') {
            throw new DomainException('FamilyHistoryEntry.condition must be non-empty');
        }
        if ($this->page <= 0) {
            throw new DomainException('FamilyHistoryEntry.page must be positive');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('FamilyHistoryEntry.confidence must be in [0, 1]');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            relation: ExtractionFieldDecoder::requireString($data, 'relation', 'FamilyHistoryEntry'),
            condition: ExtractionFieldDecoder::requireString($data, 'condition', 'FamilyHistoryEntry'),
            notes: ExtractionFieldDecoder::optionalString($data, 'notes', 'FamilyHistoryEntry'),
            page: ExtractionFieldDecoder::requireInt($data, 'page', 'FamilyHistoryEntry'),
            bbox: ExtractionFieldDecoder::requireBbox($data, 'FamilyHistoryEntry'),
            quote: ExtractionFieldDecoder::requireString($data, 'quote', 'FamilyHistoryEntry'),
            confidence: ExtractionFieldDecoder::requireConfidence($data, 'FamilyHistoryEntry'),
        );
    }

    /**
     * @return FamilyHistoryArray
     */
    public function toArray(): array
    {
        $out = [
            'relation' => $this->relation,
            'condition' => $this->condition,
            'page' => $this->page,
            'bbox' => $this->bbox,
            'quote' => $this->quote,
            'confidence' => $this->confidence,
        ];
        if ($this->notes !== null) {
            $out['notes'] = $this->notes;
        }
        return $out;
    }
}
