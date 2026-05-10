<?php

/**
 * Per-field citation envelope shared by lab-PDF and intake-form
 * extractions.
 *
 * Mirrors the `citedField(...)` helper in
 * `agent/src/pipeline/schemas/labPdf.ts` (and `intakeForm.ts`):
 * `{value, page, bbox, quote, confidence}`. Bbox is a 4-tuple in PDF
 * point space, identical to what `SourceReference` already accepts for
 * `extracted_document`-typed locators.
 *
 * The PHP side parses JSON the agent persisted to Tier 2; constructor
 * validation is the gate that catches a malformed array up front, so
 * downstream code can trust the typed accessors.
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
 * The `value` slot is intentionally `mixed` rather than generic-typed:
 * the parent DTO (LabPdfExtraction, IntakeFormExtraction) owns the
 * value-type discipline because the closed enumerations (`sex` ∈
 * {male, female, other, unknown}, etc.) live on the parent. Keeping
 * CitedField simple avoids a generic that would otherwise force every
 * caller to pin `<string>` annotations.
 *
 * Bbox is either a 4-tuple `[x, y, w, h]` (legacy axis-aligned —
 * vision-v1/v2 and referralLetter docx character offsets) or an
 * 8-tuple `[x1, y1, x2, y2, x3, y3, x4, y4]` row-spanning quad
 * introduced in `vision-v3-quad`. PHPStan can't express a length
 * union over array tuples cleanly, so we widen to `list<float|int>`
 * and rely on `ExtractionFieldDecoder::requireBbox` for the runtime
 * length check.
 *
 * @phpstan-type Bbox list<float|int>
 *
 * @phpstan-type CitedFieldArray array{
 *     value: mixed,
 *     page: int,
 *     bbox: Bbox,
 *     quote: string,
 *     confidence: float
 * }
 */
final readonly class CitedField
{
    /**
     * @param Bbox $bbox
     */
    public function __construct(
        public mixed $value,
        public int $page,
        public array $bbox,
        public string $quote,
        public float $confidence,
    ) {
        if ($this->page <= 0) {
            throw new DomainException('CitedField.page must be a positive 1-indexed page number');
        }
        // The bbox 4-tuple shape is enforced by the @param Bbox PHPDoc;
        // fromArray() runs the runtime length/coordinate checks before
        // calling here.
        if ($this->quote === '') {
            throw new DomainException('CitedField.quote must be non-empty');
        }
        if ($this->confidence < 0.0 || $this->confidence > 1.0) {
            throw new DomainException('CitedField.confidence must be in [0, 1]');
        }
    }

    /**
     * Decode a previously-serialized CitedField.
     *
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        if (!array_key_exists('value', $data)) {
            throw new DomainException('CitedField.value is required');
        }
        $page = ExtractionFieldDecoder::requireInt($data, 'page', 'CitedField');
        $bbox = ExtractionFieldDecoder::requireBbox($data, 'CitedField');
        $quote = ExtractionFieldDecoder::requireString($data, 'quote', 'CitedField');
        $confidence = ExtractionFieldDecoder::requireConfidence($data, 'CitedField');
        return new self(
            value: $data['value'],
            page: $page,
            bbox: $bbox,
            quote: $quote,
            confidence: $confidence,
        );
    }

    /**
     * @return CitedFieldArray
     */
    public function toArray(): array
    {
        return [
            'value' => $this->value,
            'page' => $this->page,
            'bbox' => $this->bbox,
            'quote' => $this->quote,
            'confidence' => $this->confidence,
        ];
    }
}
