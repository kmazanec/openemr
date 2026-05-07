<?php

/**
 * Typed input for {@see FamilyHistoryWriteService::write()}. One
 * `FamilyHistoryPromotionRequest` corresponds to one accepted
 * family-history fact extracted from an intake form — the clinician
 * clicked "accept" on a single family-history entry, the agent's
 * middleman translated it from the intake-form artifact's
 * `family_history[<idx>]` slot into this typed payload, and the service
 * writes a single `lists` row with `type='family_history'`.
 *
 * Idempotency key is `(sourceDocumentUuid, normalizedTitle)` — the
 * service computes the canonical `title` by composing
 * `"{relation} — {condition}"` with an em-dash separator (matching the
 * F.5e plan), then lower-cases + trims it. Re-promoting the same
 * relation+condition pair from the same source document returns the
 * existing UUID rather than inserting a duplicate.
 *
 * Composing the title here (rather than letting the agent middleman
 * pre-compose) keeps the canonical form on the PHP side: case + trim
 * + separator are all enforced once, so a re-promote with mixed-case
 * relation ("MOTHER" vs "Mother") still hits the same row.
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

final readonly class FamilyHistoryPromotionRequest
{
    /**
     * Em-dash separator between relation and condition in the composite
     * `title`. Matches the F.5e plan's "Mother — Type 2 diabetes" shape.
     * Kept as a public constant so the table writer + tests can compose
     * a matching expectation without re-deriving the convention.
     */
    public const TITLE_SEPARATOR = ' — ';

    public function __construct(
        public int $pid,
        public string $sourceDocumentUuid,
        public string $relation,
        public string $condition,
        public ?string $ageOfOnset,
        public ?string $comments,
        public int $promotedByUserId,
    ) {
        if ($this->pid <= 0) {
            throw new DomainException('FamilyHistoryPromotionRequest.pid must be positive');
        }
        if ($this->sourceDocumentUuid === '') {
            throw new DomainException(
                'FamilyHistoryPromotionRequest.sourceDocumentUuid must be non-empty',
            );
        }
        if ($this->relation === '') {
            throw new DomainException(
                'FamilyHistoryPromotionRequest.relation must be non-empty',
            );
        }
        if ($this->condition === '') {
            throw new DomainException(
                'FamilyHistoryPromotionRequest.condition must be non-empty',
            );
        }
        if ($this->ageOfOnset !== null && $this->ageOfOnset === '') {
            throw new DomainException(
                'FamilyHistoryPromotionRequest.ageOfOnset must be null or non-empty',
            );
        }
        if ($this->comments !== null && $this->comments === '') {
            throw new DomainException(
                'FamilyHistoryPromotionRequest.comments must be null or non-empty',
            );
        }
        if ($this->promotedByUserId <= 0) {
            throw new DomainException(
                'FamilyHistoryPromotionRequest.promotedByUserId must be positive',
            );
        }
    }

    /**
     * Composite `lists.title` for the chart row: trimmed `relation`,
     * em-dash separator, trimmed `condition`. The chart UI displays
     * this verbatim in the family-history widget.
     */
    public function title(): string
    {
        return trim($this->relation) . self::TITLE_SEPARATOR . trim($this->condition);
    }

    /**
     * Idempotency-key normalization for the composite `title`. Lower
     * + trim. The service uses this both at the find-existing step
     * and (indirectly) at the insert step so a re-promote of
     * "Mother — Type 2 diabetes" after the first "  MOTHER — type 2
     * DIABETES  " write hits the same row.
     */
    public function normalizedTitle(): string
    {
        return strtolower(trim($this->title()));
    }
}
