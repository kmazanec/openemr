<?php

/**
 * Typed input for {@see MedicationStatementWriteService::write()}. One
 * `MedicationStatementPromotionRequest` corresponds to one accepted
 * patient-reported-medication fact extracted from an intake form — the
 * clinician clicked "accept" on a single medication entry, the agent's
 * middleman translated it from the intake-form artifact's
 * `current_medications[<idx>]` slot into this typed payload, and the
 * service writes one `lists` row (type='medication') plus a sibling
 * `lists_medication` row flagged as a reported (not primary) record.
 *
 * Idempotency key is `(sourceDocumentUuid, normalizedDrugName)` — the
 * service computes the normalized form (lower + trim) before the
 * lookup, so re-promoting the same medication from the same source
 * document returns the existing UUID rather than inserting a
 * duplicate. The free-text `usageCategory` / `usageCategoryTitle` /
 * `requestIntent` / `requestIntentTitle` flow into
 * `lists_medication.usage_category`, `usage_category_title`,
 * `request_intent`, `request_intent_title` verbatim; the title columns
 * are NOT NULL on the schema so the parser supplies sensible defaults
 * (`community` / `Home/Community` and `plan` / `Plan`) when the body
 * omits them. See `MedicationStatementPromotionRequestParser` for the
 * default-resolution path.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use DomainException;

final readonly class MedicationStatementPromotionRequest
{
    public function __construct(
        public int $pid,
        public string $sourceDocumentUuid,
        public string $drugName,
        public ?string $dosageInstructions,
        public string $usageCategory,
        public string $usageCategoryTitle,
        public string $requestIntent,
        public string $requestIntentTitle,
        public ?string $comments,
        public ?string $onsetDate,
        public int $promotedByUserId,
    ) {
        if ($this->pid <= 0) {
            throw new DomainException('MedicationStatementPromotionRequest.pid must be positive');
        }
        if ($this->sourceDocumentUuid === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.sourceDocumentUuid must be non-empty',
            );
        }
        if ($this->drugName === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.drugName must be non-empty',
            );
        }
        if ($this->dosageInstructions !== null && $this->dosageInstructions === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.dosageInstructions must be null or non-empty',
            );
        }
        if ($this->usageCategory === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.usageCategory must be non-empty',
            );
        }
        if ($this->usageCategoryTitle === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.usageCategoryTitle must be non-empty',
            );
        }
        if ($this->requestIntent === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.requestIntent must be non-empty',
            );
        }
        if ($this->requestIntentTitle === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.requestIntentTitle must be non-empty',
            );
        }
        if ($this->comments !== null && $this->comments === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.comments must be null or non-empty',
            );
        }
        if ($this->onsetDate !== null && $this->onsetDate === '') {
            throw new DomainException(
                'MedicationStatementPromotionRequest.onsetDate must be null or non-empty',
            );
        }
        if ($this->promotedByUserId <= 0) {
            throw new DomainException(
                'MedicationStatementPromotionRequest.promotedByUserId must be positive',
            );
        }
    }

    /**
     * Idempotency-key normalization for `drugName`. Lower-case + trim.
     * The service uses this both at the find-existing step and at the
     * insert step so a re-promote of "Lisinopril 10mg" after the first
     * "lisinopril 10mg " write hits the same row.
     */
    public function normalizedDrugName(): string
    {
        return strtolower(trim($this->drugName));
    }
}
