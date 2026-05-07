<?php

/**
 * Parses the agent-side JSON body of a `?type=past_medical_history`
 * promotion request into a typed {@see MedicalProblemPromotionRequest}.
 *
 * Same "parse, don't validate" boundary discipline as the lab and
 * allergy parsers.
 *
 * Body shape mirrors what the agent middleman sends after
 * materializing an `intake_form` artifact's
 * `past_medical_history[<idx>]` slot:
 *
 *     {
 *       "pid": 4242,
 *       "source_document_uuid": "aaaaaaaa-...",
 *       "title": "Type 2 diabetes",         // human-readable condition label
 *       "diagnosis": "ICD10:E11.9",         // optional coded value, free text
 *       "verification_option_id": "confirmed", // optional, list_options pass-through
 *       "comments": "patient-reported on intake form", // optional
 *       "onset_date": "2014-01-01"          // optional ISO date
 *     }
 *
 * `promoted_by_user_id` is *not* a body field; it comes from the
 * verified JWT actor and is supplied by the controller. This prevents
 * an over-broadly minted token from spoofing a different user's
 * promotion attribution.
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
use OpenEMR\Modules\ClinicalCopilot\Service\MedicalProblemPromotionRequest;

final class MedicalProblemPromotionRequestParser
{
    /**
     * @param array<string, mixed> $body
     */
    public static function parse(array $body, int $promotedByUserId): MedicalProblemPromotionRequest
    {
        return new MedicalProblemPromotionRequest(
            pid: self::requirePositiveInt($body, 'pid'),
            sourceDocumentUuid: self::requireNonEmptyString($body, 'source_document_uuid'),
            title: self::requireNonEmptyString($body, 'title'),
            diagnosis: self::optionalNonEmptyString($body, 'diagnosis'),
            verificationOptionId: self::optionalNonEmptyString($body, 'verification_option_id'),
            comments: self::optionalNonEmptyString($body, 'comments'),
            onsetDate: self::optionalNonEmptyString($body, 'onset_date'),
            promotedByUserId: $promotedByUserId,
        );
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

    /**
     * @param array<string, mixed> $body
     */
    private static function optionalNonEmptyString(array $body, string $key): ?string
    {
        if (!array_key_exists($key, $body) || $body[$key] === null) {
            return null;
        }
        return self::requireNonEmptyString($body, $key);
    }
}
