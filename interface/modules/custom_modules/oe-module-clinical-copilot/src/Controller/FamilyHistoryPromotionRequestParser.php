<?php

/**
 * Parses the agent-side JSON body of a `?type=family_history`
 * promotion request into a typed
 * {@see FamilyHistoryPromotionRequest}.
 *
 * Same "parse, don't validate" boundary discipline as the lab and
 * allergy parsers.
 *
 * Body shape mirrors what the agent middleman sends after
 * materializing an `intake_form` artifact's `family_history[<idx>]`
 * slot:
 *
 *     {
 *       "pid": 4242,
 *       "source_document_uuid": "aaaaaaaa-...",
 *       "relation": "Mother",
 *       "condition": "Type 2 diabetes",
 *       "age_of_onset": "1998-04-01",   // optional ISO date — typically null
 *                                       //   today (intake-form schema lacks
 *                                       //   the field) but accepted for
 *                                       //   forward-compat
 *       "comments": "diagnosed in mid-30s"  // optional, free text from `notes`
 *     }
 *
 * The PHP service composes the canonical `title` from
 * `relation + condition` so idempotency works on a single canonical
 * form (em-dash separator, lower + trim normalization). The agent
 * middleman therefore passes `relation` and `condition` separately
 * rather than pre-composing client-side.
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
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryPromotionRequest;

final class FamilyHistoryPromotionRequestParser
{
    /**
     * @param array<string, mixed> $body
     */
    public static function parse(
        array $body,
        int $promotedByUserId,
    ): FamilyHistoryPromotionRequest {
        return new FamilyHistoryPromotionRequest(
            pid: self::requirePositiveInt($body, 'pid'),
            sourceDocumentUuid: self::requireNonEmptyString($body, 'source_document_uuid'),
            relation: self::requireNonEmptyString($body, 'relation'),
            condition: self::requireNonEmptyString($body, 'condition'),
            ageOfOnset: self::optionalNonEmptyString($body, 'age_of_onset'),
            comments: self::optionalNonEmptyString($body, 'comments'),
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
