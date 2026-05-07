<?php

/**
 * Parses the agent-side JSON body of a `?type=medication_statement`
 * promotion request into a typed
 * {@see MedicationStatementPromotionRequest}.
 *
 * Same "parse, don't validate" boundary discipline as the lab + allergy
 * parsers.
 *
 * Body shape mirrors what the agent middleman sends after materializing
 * an `intake_form` artifact's `current_medications[<idx>]` slot:
 *
 *     {
 *       "pid": 4242,
 *       "source_document_uuid": "aaaaaaaa-...",
 *       "drug_name": "lisinopril 10mg",
 *       "dosage_instructions": "1 tablet daily by mouth, take with food",
 *       "usage_category": "community",        // optional, defaults to community
 *       "usage_category_title": "Home/Community", // optional, defaults to Home/Community
 *       "request_intent": "plan",             // optional, defaults to plan
 *       "request_intent_title": "Plan",       // optional, defaults to Plan
 *       "comments": "patient reports good adherence", // optional
 *       "onset_date": "2024-06-01"            // optional ISO date
 *     }
 *
 * `promoted_by_user_id` is *not* a body field; it comes from the
 * verified JWT actor and is supplied by the controller.
 *
 * Defaults for `usage_category` / `request_intent` (and their
 * companion `*_title` columns, which are NOT NULL on the schema):
 * intake-form / patient-reported medications best fit
 * `community` / `Home/Community` (the FHIR
 * MedicationRequest category for self-administered home meds) and
 * `plan` / `Plan` (the FHIR MedicationRequest intent for a chart
 * record that documents an intended use without authorizing a
 * dispense). Both option_ids are seeded in stock OpenEMR's
 * `list_options` table — see
 * `MedicationPatientIssueService::LIST_OPTION_MEDICATION_*` for the
 * FK lookups, though this writer mirrors the
 * F.5b-allergy precedent of passing the agent's free text through
 * verbatim without `list_options` validation. The chart UI displays
 * the title columns as-is.
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
use OpenEMR\Modules\ClinicalCopilot\Service\MedicationStatementPromotionRequest;

final class MedicationStatementPromotionRequestParser
{
    public const DEFAULT_USAGE_CATEGORY = 'community';
    public const DEFAULT_USAGE_CATEGORY_TITLE = 'Home/Community';
    public const DEFAULT_REQUEST_INTENT = 'plan';
    public const DEFAULT_REQUEST_INTENT_TITLE = 'Plan';

    /**
     * @param array<string, mixed> $body
     */
    public static function parse(
        array $body,
        int $promotedByUserId,
    ): MedicationStatementPromotionRequest {
        return new MedicationStatementPromotionRequest(
            pid: self::requirePositiveInt($body, 'pid'),
            sourceDocumentUuid: self::requireNonEmptyString($body, 'source_document_uuid'),
            drugName: self::requireNonEmptyString($body, 'drug_name'),
            dosageInstructions: self::optionalNonEmptyString($body, 'dosage_instructions'),
            usageCategory: self::optionalNonEmptyString($body, 'usage_category')
                ?? self::DEFAULT_USAGE_CATEGORY,
            usageCategoryTitle: self::optionalNonEmptyString($body, 'usage_category_title')
                ?? self::DEFAULT_USAGE_CATEGORY_TITLE,
            requestIntent: self::optionalNonEmptyString($body, 'request_intent')
                ?? self::DEFAULT_REQUEST_INTENT,
            requestIntentTitle: self::optionalNonEmptyString($body, 'request_intent_title')
                ?? self::DEFAULT_REQUEST_INTENT_TITLE,
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
