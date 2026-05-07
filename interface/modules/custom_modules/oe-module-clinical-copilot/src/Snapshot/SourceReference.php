<?php

/**
 * Unified W2 source reference attached to every clinical fact the
 * agent cites.
 *
 * Mirrors `W2_ARCHITECTURE.md` §"Unified `SourceReference` shape":
 * every fact carries one of these, discriminated by `source_type`,
 * with locator polymorphism enforced at construction. The TS-side
 * mirror lives at `agent/src/graph/types.ts` (`SourceReferenceSchema`)
 * and the cross-language contract is pinned by
 * `tests/Tests/Isolated/Modules/ClinicalCopilot/Snapshot/SourceReferenceContractTest.php`
 * against the same fixture the agent's Vitest contract test reads.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use DomainException;

/**
 * @phpstan-type LocatorArray array{
 *     page?: int,
 *     bbox?: array{0: float|int, 1: float|int, 2: float|int, 3: float|int},
 *     section?: string,
 *     field?: string,
 * }
 * @phpstan-type MetaArray array{
 *     document_uuid?: string,
 *     extractor_version?: string,
 *     rerank_score?: float|int,
 *     record_recorded_at?: string,
 *     publication?: string,
 *     title?: string,
 *     year?: int,
 *     url?: string,
 *     section?: string,
 * }
 * @phpstan-type SourceReferenceArray array{
 *     source_type: 'chart'|'extracted_document'|'guideline',
 *     source_id: string,
 *     locator: LocatorArray,
 *     quote: string,
 *     confidence?: float,
 *     meta?: MetaArray,
 * }
 */
final readonly class SourceReference
{
    public const SOURCE_TYPE_CHART = 'chart';
    public const SOURCE_TYPE_EXTRACTED_DOCUMENT = 'extracted_document';
    public const SOURCE_TYPE_GUIDELINE = 'guideline';

    private const ALLOWED_SOURCE_TYPES = [
        self::SOURCE_TYPE_CHART,
        self::SOURCE_TYPE_EXTRACTED_DOCUMENT,
        self::SOURCE_TYPE_GUIDELINE,
    ];

    /**
     * @param 'chart'|'extracted_document'|'guideline' $sourceType
     * @param LocatorArray $locator
     * @param MetaArray|null $meta
     */
    public function __construct(
        public string $sourceType,
        public string $sourceId,
        public array $locator,
        public string $quote,
        public ?float $confidence = null,
        public ?array $meta = null,
    ) {
        if (!in_array($sourceType, self::ALLOWED_SOURCE_TYPES, true)) {
            throw new DomainException("SourceReference.source_type must be one of chart|extracted_document|guideline; got '{$sourceType}'");
        }
        if ($sourceId === '') {
            throw new DomainException('SourceReference.source_id must not be empty');
        }
        if ($quote === '') {
            throw new DomainException('SourceReference.quote must not be empty');
        }
        if ($confidence !== null && ($confidence < 0.0 || $confidence > 1.0)) {
            throw new DomainException('SourceReference.confidence must be between 0 and 1');
        }
        $this->validateLocator($sourceType, $locator);
    }

    /**
     * Locator polymorphism rule, lifted from `W2_ARCHITECTURE.md`
     * §"Unified `SourceReference` shape" so a citation that cannot
     * be resolved at verification time fails at construction
     * instead.
     *
     * Typed loosely as `array<string, mixed>` rather than
     * `LocatorArray`: this is the runtime gate, not a type-narrowed
     * helper. The constructor is callable with any array shape via
     * `fromArray` deserialization, so the runtime checks must hold
     * regardless of what the static-type-checker can prove.
     *
     * @param array<string, mixed> $locator
     */
    private function validateLocator(string $sourceType, array $locator): void
    {
        switch ($sourceType) {
            case self::SOURCE_TYPE_EXTRACTED_DOCUMENT:
                if (!array_key_exists('page', $locator)) {
                    throw new DomainException('extracted_document SourceReference requires locator.page');
                }
                if (!array_key_exists('bbox', $locator)) {
                    throw new DomainException('extracted_document SourceReference requires locator.bbox');
                }
                $bbox = $locator['bbox'];
                if (!is_array($bbox) || count($bbox) !== 4) {
                    throw new DomainException('SourceReference.locator.bbox must be a 4-tuple');
                }
                break;
            case self::SOURCE_TYPE_GUIDELINE:
                if (!array_key_exists('section', $locator) || $locator['section'] === '') {
                    throw new DomainException('guideline SourceReference requires non-empty locator.section');
                }
                break;
            case self::SOURCE_TYPE_CHART:
                if (!array_key_exists('field', $locator) || $locator['field'] === '') {
                    throw new DomainException('chart SourceReference requires non-empty locator.field');
                }
                break;
        }
    }

    /**
     * @return SourceReferenceArray
     */
    public function toArray(): array
    {
        $out = [
            'source_type' => $this->sourceType,
            'source_id' => $this->sourceId,
            'locator' => $this->locator,
            'quote' => $this->quote,
        ];
        if ($this->confidence !== null) {
            $out['confidence'] = $this->confidence;
        }
        if ($this->meta !== null && $this->meta !== []) {
            $out['meta'] = $this->meta;
        }
        /** @var SourceReferenceArray $out */
        return $out;
    }

    /**
     * Decode a previously-serialized SourceReference. Validates the
     * same polymorphism the constructor does, so a malformed array
     * throws `DomainException` rather than producing a half-built
     * object.
     *
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $sourceType = $data['source_type'] ?? null;
        if (!in_array($sourceType, self::ALLOWED_SOURCE_TYPES, true)) {
            throw new DomainException('SourceReference.source_type must be one of chart|extracted_document|guideline');
        }
        $sourceId = $data['source_id'] ?? null;
        if (!is_string($sourceId)) {
            throw new DomainException('SourceReference.source_id must be a string');
        }
        $locator = $data['locator'] ?? null;
        if (!is_array($locator)) {
            throw new DomainException('SourceReference.locator must be an object');
        }
        $quote = $data['quote'] ?? null;
        if (!is_string($quote)) {
            throw new DomainException('SourceReference.quote must be a string');
        }
        $confidence = $data['confidence'] ?? null;
        if ($confidence !== null && !is_float($confidence) && !is_int($confidence)) {
            throw new DomainException('SourceReference.confidence must be numeric or absent');
        }
        $meta = $data['meta'] ?? null;
        if ($meta !== null && !is_array($meta)) {
            throw new DomainException('SourceReference.meta must be an object or absent');
        }

        /** @var LocatorArray $locator */
        /** @var MetaArray|null $meta */
        return new self(
            sourceType: $sourceType,
            sourceId: $sourceId,
            locator: $locator,
            quote: $quote,
            confidence: $confidence !== null ? (float) $confidence : null,
            meta: $meta,
        );
    }
}
