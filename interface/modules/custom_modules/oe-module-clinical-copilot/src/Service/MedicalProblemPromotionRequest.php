<?php

/**
 * Typed input for {@see MedicalProblemWriteService::write()}. One
 * `MedicalProblemPromotionRequest` corresponds to one accepted
 * past-medical-history fact extracted from an intake form — the
 * clinician clicked "accept" on a single condition entry, the agent's
 * middleman translated it from the intake-form artifact's
 * `past_medical_history[<idx>]` slot into this typed payload, and the
 * service writes a single `lists` row with `type='medical_problem'`.
 *
 * Idempotency key is `(sourceDocumentUuid, normalizedTitle)` — the
 * service computes the normalized form (lower + trim) on `title`
 * before the lookup, so re-promoting the same condition from the same
 * source document returns the existing UUID rather than inserting a
 * duplicate. Title (not diagnosis) is the natural key because the
 * intake-form schema reliably carries a `condition` string but rarely
 * an ICD/SNOMED code.
 *
 * `diagnosis` is optional free text. If the agent supplies a
 * coding-system-prefixed value (e.g. `ICD10:E11.9`) it flows through
 * verbatim into `lists.diagnosis`. Otherwise the column stays empty
 * and `lists.title` carries the human label. The `verificationOptionId`
 * pass-through follows the F.5b precedent (`list_options` FK columns
 * are populated as free text; the chart UI handles missing FK joins
 * fine).
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

final readonly class MedicalProblemPromotionRequest
{
    public function __construct(
        public int $pid,
        public string $sourceDocumentUuid,
        public string $title,
        public ?string $diagnosis,
        public ?string $verificationOptionId,
        public ?string $comments,
        public ?string $onsetDate,
        public int $promotedByUserId,
    ) {
        if ($this->pid <= 0) {
            throw new DomainException('MedicalProblemPromotionRequest.pid must be positive');
        }
        if ($this->sourceDocumentUuid === '') {
            throw new DomainException(
                'MedicalProblemPromotionRequest.sourceDocumentUuid must be non-empty',
            );
        }
        if ($this->title === '') {
            throw new DomainException('MedicalProblemPromotionRequest.title must be non-empty');
        }
        if ($this->diagnosis !== null && $this->diagnosis === '') {
            throw new DomainException(
                'MedicalProblemPromotionRequest.diagnosis must be null or non-empty',
            );
        }
        if ($this->verificationOptionId !== null && $this->verificationOptionId === '') {
            throw new DomainException(
                'MedicalProblemPromotionRequest.verificationOptionId must be null or non-empty',
            );
        }
        if ($this->comments !== null && $this->comments === '') {
            throw new DomainException(
                'MedicalProblemPromotionRequest.comments must be null or non-empty',
            );
        }
        if ($this->onsetDate !== null && $this->onsetDate === '') {
            throw new DomainException(
                'MedicalProblemPromotionRequest.onsetDate must be null or non-empty',
            );
        }
        if ($this->promotedByUserId <= 0) {
            throw new DomainException(
                'MedicalProblemPromotionRequest.promotedByUserId must be positive',
            );
        }
    }

    /**
     * Idempotency-key normalization for `title`. Lower-case + trim. The
     * service uses this both at the find-existing step and at the
     * insert step so a re-promote of "Type 2 Diabetes" after the first
     * "type 2 diabetes " write hits the same row.
     */
    public function normalizedTitle(): string
    {
        return strtolower(trim($this->title));
    }
}
