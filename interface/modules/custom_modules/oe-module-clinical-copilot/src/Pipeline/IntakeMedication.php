<?php

/**
 * Patient-reported medication line on an intake form. Mirrors
 * `medicationSchema` in `agent/src/pipeline/schemas/intakeForm.ts`.
 *
 * RxNorm coding is Tier-3's job — this DTO carries free-text directions
 * verbatim.
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
 * @phpstan-import-type IntakeMedicationArray from IntakeFormExtraction
 */
final readonly class IntakeMedication
{
    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public string $name,
        public ?string $dose,
        public ?string $frequency,
        public ?string $route,
        public ?string $notes,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->name === '') {
            throw new DomainException('IntakeMedication.name must be non-empty');
        }
        if ($this->page <= 0) {
            throw new DomainException('IntakeMedication.page must be positive');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('IntakeMedication.confidence must be in [0, 1]');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $name = ExtractionFieldDecoder::requireString($data, 'name', 'IntakeMedication');
        $page = ExtractionFieldDecoder::requireInt($data, 'page', 'IntakeMedication');
        $bbox = ExtractionFieldDecoder::requireBbox($data, 'IntakeMedication');
        $quote = ExtractionFieldDecoder::requireString($data, 'quote', 'IntakeMedication');
        $confidence = ExtractionFieldDecoder::requireConfidence($data, 'IntakeMedication');
        return new self(
            name: $name,
            dose: ExtractionFieldDecoder::optionalString($data, 'dose', 'IntakeMedication'),
            frequency: ExtractionFieldDecoder::optionalString($data, 'frequency', 'IntakeMedication'),
            route: ExtractionFieldDecoder::optionalString($data, 'route', 'IntakeMedication'),
            notes: ExtractionFieldDecoder::optionalString($data, 'notes', 'IntakeMedication'),
            page: $page,
            bbox: $bbox,
            quote: $quote,
            confidence: $confidence,
        );
    }

    /**
     * @return IntakeMedicationArray
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
        if ($this->dose !== null) {
            $out['dose'] = $this->dose;
        }
        if ($this->frequency !== null) {
            $out['frequency'] = $this->frequency;
        }
        if ($this->route !== null) {
            $out['route'] = $this->route;
        }
        if ($this->notes !== null) {
            $out['notes'] = $this->notes;
        }
        return $out;
    }
}
