<?php

/**
 * Parses the agent-side JSON body of a `?type=demographics` promotion
 * request into a typed {@see DemographicsPromotionRequest}.
 *
 * Same "parse, don't validate" boundary discipline as the F.5b–F.5e
 * parsers.
 *
 * Body shape mirrors what the agent middleman sends after
 * materializing one cited slot from an `intake_form` artifact's
 * `patient_demographics.{address|phone|email}.value`:
 *
 *     {
 *       "pid": 4242,
 *       "source_document_uuid": "aaaaaaaa-...",
 *       "field": "address",
 *       "value": "742 Evergreen Terrace, Springfield IL 62701"
 *     }
 *
 * `field` is one of the closed set `address|phone|email` matching
 * {@see DemographicsField}; an unknown value rejects with
 * `\DomainException`. `value` is required and non-empty.
 *
 * `promoted_by_user_id` is *not* a body field; it comes from the
 * verified JWT actor and is supplied by the controller. Same
 * over-broad-token-defense as the other Tier-3 parsers.
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
use OpenEMR\Modules\ClinicalCopilot\Service\DemographicsField;
use OpenEMR\Modules\ClinicalCopilot\Service\DemographicsPromotionRequest;

final class DemographicsPromotionRequestParser
{
    /**
     * @param array<string, mixed> $body
     */
    public static function parse(array $body, int $promotedByUserId): DemographicsPromotionRequest
    {
        return new DemographicsPromotionRequest(
            pid: self::requirePositiveInt($body, 'pid'),
            sourceDocumentUuid: self::requireNonEmptyString($body, 'source_document_uuid'),
            field: self::requireField($body),
            value: self::requireNonEmptyString($body, 'value'),
            promotedByUserId: $promotedByUserId,
        );
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function requireField(array $body): DemographicsField
    {
        $raw = $body['field'] ?? null;
        if (!is_string($raw)) {
            throw new DomainException('field must be a string');
        }
        $enum = DemographicsField::tryFrom($raw);
        if ($enum === null) {
            throw new DomainException('field must be one of address|phone|email');
        }
        return $enum;
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function requirePositiveInt(array $body, string $key): int
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
        throw new DomainException($key . ' must be a positive integer');
    }

    /**
     * @param array<string, mixed> $body
     */
    private static function requireNonEmptyString(array $body, string $key): string
    {
        $raw = $body[$key] ?? null;
        if (!is_string($raw)) {
            throw new DomainException($key . ' must be a string');
        }
        $trimmed = trim($raw);
        if ($trimmed === '') {
            throw new DomainException($key . ' must be non-empty');
        }
        return $trimmed;
    }
}
