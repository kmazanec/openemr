<?php

/**
 * One allergy line on an intake form. Mirrors `allergySchema` in
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
 * @phpstan-import-type IntakeAllergyArray from IntakeFormExtraction
 */
final readonly class IntakeAllergy
{
    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public string $substance,
        public ?string $reaction,
        public ?string $severity,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->substance === '') {
            throw new DomainException('IntakeAllergy.substance must be non-empty');
        }
        if ($this->page <= 0) {
            throw new DomainException('IntakeAllergy.page must be positive');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('IntakeAllergy.confidence must be in [0, 1]');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            substance: ExtractionFieldDecoder::requireString($data, 'substance', 'IntakeAllergy'),
            reaction: ExtractionFieldDecoder::optionalString($data, 'reaction', 'IntakeAllergy'),
            severity: ExtractionFieldDecoder::optionalString($data, 'severity', 'IntakeAllergy'),
            page: ExtractionFieldDecoder::requireInt($data, 'page', 'IntakeAllergy'),
            bbox: ExtractionFieldDecoder::requireBbox($data, 'IntakeAllergy'),
            quote: ExtractionFieldDecoder::requireString($data, 'quote', 'IntakeAllergy'),
            confidence: ExtractionFieldDecoder::requireConfidence($data, 'IntakeAllergy'),
        );
    }

    /**
     * @return IntakeAllergyArray
     */
    public function toArray(): array
    {
        $out = [
            'substance' => $this->substance,
            'page' => $this->page,
            'bbox' => $this->bbox,
            'quote' => $this->quote,
            'confidence' => $this->confidence,
        ];
        if ($this->reaction !== null) {
            $out['reaction'] = $this->reaction;
        }
        if ($this->severity !== null) {
            $out['severity'] = $this->severity;
        }
        return $out;
    }
}
