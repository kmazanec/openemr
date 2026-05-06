<?php

/**
 * Parses the agent-side JSON body of a `?type=lab` promotion request
 * into a typed {@see LabPromotionRequest}.
 *
 * "Parse, don't validate" applied at the controller boundary: the
 * service-layer code never sees a raw array — once parsing returns,
 * every value is the right type, every required field is present, and
 * every list is non-empty. Failures throw `DomainException` carrying
 * the field path; the controller maps them all to one
 * `invalid_body` 400 response (the field-level reason is logged but
 * not exposed to the caller — exception messages may carry detail
 * that doesn't belong in HTTP error envelopes per CLAUDE.md "Never
 * expose `$e->getMessage()` in user-facing output").
 *
 * Body shape mirrors what the agent sends today
 * (`agent/src/promote/labPayload.ts` once F.5 lands; the field names
 * line up with the W2 lab-PDF extraction schema):
 *
 *     {
 *       "pid": 4242,
 *       "source_document_uuid": "aaaaaaaa-...",
 *       "panel_code": "57021-8",        // optional, may be null
 *       "collection_date": "2026-04-15",
 *       "results": [
 *         {
 *           "analyte_name": "Hemoglobin A1c",
 *           "value": "5.7",
 *           "unit": "%",
 *           "ref_range_low": "4.0",     // optional
 *           "ref_range_high": "5.6",    // optional
 *           "abnormal_flag": "high"     // optional
 *         },
 *         ...
 *       ]
 *     }
 *
 * `promoted_by_user_id` is *not* a body field; it comes from the
 * verified JWT actor and is supplied by the controller, not the
 * caller. This prevents an over-broadly minted token from spoofing a
 * different user's promotion attribution.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Service\LabPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\ObservationResult;

final class LabPromotionRequestParser
{
    /**
     * @param array<string, mixed> $body
     */
    public static function parse(array $body, int $promotedByUserId): LabPromotionRequest
    {
        $pid = self::requirePositiveInt($body, 'pid');
        $sourceDocumentUuid = self::requireNonEmptyString($body, 'source_document_uuid');
        $panelCode = self::optionalNonEmptyString($body, 'panel_code');
        $collectionDate = self::requireNonEmptyString($body, 'collection_date');

        $rawResults = $body['results'] ?? null;
        if (!is_array($rawResults) || $rawResults === []) {
            throw new DomainException('results must be a non-empty array');
        }

        // PHPStan narrows `non-empty-array<int, mixed>` (which is what
        // `$rawResults` is after the `=== []` rejection above) +
        // single-append-per-iteration into `non-empty-list<ObservationResult>`
        // automatically, so no follow-up emptiness check is needed.
        $results = [];
        foreach ($rawResults as $idx => $row) {
            if (!is_array($row)) {
                throw new DomainException("results[$idx] must be an object");
            }
            /** @var array<string, mixed> $row */
            $results[] = self::parseResult($row, (int) $idx);
        }

        return new LabPromotionRequest(
            pid: $pid,
            sourceDocumentUuid: $sourceDocumentUuid,
            panelCode: $panelCode,
            collectionDate: $collectionDate,
            results: $results,
            promotedByUserId: $promotedByUserId,
        );
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function parseResult(array $row, int $idx): ObservationResult
    {
        $prefix = "results[$idx]";
        return new ObservationResult(
            analyteName: self::requireNonEmptyString($row, 'analyte_name', $prefix),
            value: self::requireNonEmptyString($row, 'value', $prefix),
            unit: self::requireNonEmptyString($row, 'unit', $prefix),
            refRangeLow: self::optionalNonEmptyString($row, 'ref_range_low', $prefix),
            refRangeHigh: self::optionalNonEmptyString($row, 'ref_range_high', $prefix),
            abnormalFlag: self::optionalNonEmptyString($row, 'abnormal_flag', $prefix),
        );
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function requirePositiveInt(array $body, string $key, string $prefix = ''): int
    {
        $raw = $body[$key] ?? null;
        if (is_int($raw) && $raw > 0) {
            return $raw;
        }
        if (is_string($raw) && ctype_digit($raw)) {
            $val = (int) $raw;
            if ($val > 0) {
                return $val;
            }
        }
        throw new DomainException(self::path($prefix, $key) . ' must be a positive integer');
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function requireNonEmptyString(array $body, string $key, string $prefix = ''): string
    {
        $raw = $body[$key] ?? null;
        if (!is_string($raw)) {
            throw new DomainException(self::path($prefix, $key) . ' must be a string');
        }
        $trimmed = trim($raw);
        if ($trimmed === '') {
            throw new DomainException(self::path($prefix, $key) . ' must be non-empty');
        }
        return $trimmed;
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function optionalNonEmptyString(array $body, string $key, string $prefix = ''): ?string
    {
        if (!array_key_exists($key, $body) || $body[$key] === null) {
            return null;
        }
        return self::requireNonEmptyString($body, $key, $prefix);
    }

    private static function path(string $prefix, string $key): string
    {
        return $prefix === '' ? $key : "$prefix.$key";
    }
}
