<?php

/**
 * Decode helpers for the per-field extraction envelope shared across
 * lab-PDF and intake-form DTOs.
 *
 * Each row in the extraction (a result, an allergy, a medication, etc.)
 * carries the same `{page, bbox, quote, confidence}` quartet plus its
 * domain-specific fields. Without these helpers each `fromArray`
 * would re-implement the same is_string / is_int / is_array(bbox)
 * checks; with them the per-class decoders stay focused on the fields
 * that actually differ.
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

final class ExtractionFieldDecoder
{
    /**
     * Static-only utility — block instantiation.
     */
    private function __construct()
    {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function requireString(array $data, string $key, string $context): string
    {
        $value = $data[$key] ?? null;
        if (!is_string($value)) {
            throw new DomainException("{$context}.{$key} must be a string");
        }
        return $value;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function optionalString(array $data, string $key, string $context): ?string
    {
        if (!array_key_exists($key, $data)) {
            return null;
        }
        $value = $data[$key];
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new DomainException("{$context}.{$key} must be a string when present");
        }
        return $value;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function requireInt(array $data, string $key, string $context): int
    {
        $value = $data[$key] ?? null;
        if (!is_int($value)) {
            throw new DomainException("{$context}.{$key} must be an int");
        }
        return $value;
    }

    /**
     * Decode a citation bbox. Accepts either:
     *   - 4-tuple `[x, y, w, h]` legacy axis-aligned shape (vision-v1/
     *     v2 lab/intake extractions, and the referralLetter docx
     *     character-offset shape `[charStart, charEnd, 0, 0]`);
     *   - 8-tuple `[x1, y1, x2, y2, x3, y3, x4, y4]` row-spanning quad
     *     introduced in `vision-v3-quad`. The quad follows the row's
     *     angle on the page so a tilted scan still gets a tight outline.
     * Downstream renderers branch on `count($bbox)`.
     *
     * @param array<string, mixed> $data
     * @return list<float|int>
     */
    public static function requireBbox(array $data, string $context): array
    {
        $bbox = $data['bbox'] ?? null;
        if (!is_array($bbox) || (count($bbox) !== 4 && count($bbox) !== 8)) {
            throw new DomainException("{$context}.bbox must be a 4- or 8-tuple");
        }
        $out = [];
        foreach ($bbox as $coord) {
            if (!is_int($coord) && !is_float($coord)) {
                throw new DomainException("{$context}.bbox coordinates must be numeric");
            }
            $out[] = $coord;
        }
        return $out;
    }

    /**
     * Decode a required nested object — narrows to `array<string, mixed>`
     * (the JSON-decoded object shape) so PHPStan can pass it to other
     * `fromArray` decoders without losing the key type.
     *
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public static function requireObject(array $data, string $key, string $context): array
    {
        $value = $data[$key] ?? null;
        if (!is_array($value)) {
            throw new DomainException("{$context}.{$key} must be an object");
        }
        /** @var array<string, mixed> $value */
        return $value;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function requireConfidence(array $data, string $context): float
    {
        $value = $data['confidence'] ?? null;
        if (is_int($value)) {
            $value = (float) $value;
        }
        if (!is_float($value)) {
            throw new DomainException("{$context}.confidence must be a number");
        }
        return $value;
    }
}
