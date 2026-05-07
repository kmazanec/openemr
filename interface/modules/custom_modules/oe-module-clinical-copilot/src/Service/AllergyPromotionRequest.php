<?php

/**
 * Typed input for {@see AllergyListWriteService::write()}. One
 * `AllergyPromotionRequest` corresponds to one accepted allergy fact
 * extracted from an intake form — the clinician clicked "accept" on a
 * single allergy entry, the agent's middleman translated it from the
 * intake-form artifact's `allergies[<idx>]` slot into this typed
 * payload, and the service writes a single `lists` row with
 * `type='allergy'`.
 *
 * Idempotency key is `(sourceDocumentUuid, normalizedSubstance)` — the
 * service computes the normalized form (lower + trim) before the
 * lookup, so re-promoting the same allergy from the same source
 * document returns the existing UUID rather than inserting a
 * duplicate. The optional FK columns (`reactionOptionId`,
 * `verificationOptionId`) and the free-text `severity` flow into
 * `lists.reaction` / `lists.verification` / `lists.severity_al`
 * verbatim; the agent middleman is responsible for picking sensible
 * `list_options` keys from the extracted free text.
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

final readonly class AllergyPromotionRequest
{
    public function __construct(
        public int $pid,
        public string $sourceDocumentUuid,
        public string $substance,
        public ?string $reactionOptionId,
        public ?string $verificationOptionId,
        public ?string $severity,
        public ?string $comments,
        public ?string $onsetDate,
        public int $promotedByUserId,
    ) {
        if ($this->pid <= 0) {
            throw new DomainException('AllergyPromotionRequest.pid must be positive');
        }
        if ($this->sourceDocumentUuid === '') {
            throw new DomainException(
                'AllergyPromotionRequest.sourceDocumentUuid must be non-empty',
            );
        }
        if ($this->substance === '') {
            throw new DomainException('AllergyPromotionRequest.substance must be non-empty');
        }
        if ($this->reactionOptionId !== null && $this->reactionOptionId === '') {
            throw new DomainException(
                'AllergyPromotionRequest.reactionOptionId must be null or non-empty',
            );
        }
        if ($this->verificationOptionId !== null && $this->verificationOptionId === '') {
            throw new DomainException(
                'AllergyPromotionRequest.verificationOptionId must be null or non-empty',
            );
        }
        if ($this->severity !== null && $this->severity === '') {
            throw new DomainException(
                'AllergyPromotionRequest.severity must be null or non-empty',
            );
        }
        if ($this->comments !== null && $this->comments === '') {
            throw new DomainException(
                'AllergyPromotionRequest.comments must be null or non-empty',
            );
        }
        if ($this->onsetDate !== null && $this->onsetDate === '') {
            throw new DomainException(
                'AllergyPromotionRequest.onsetDate must be null or non-empty',
            );
        }
        if ($this->promotedByUserId <= 0) {
            throw new DomainException(
                'AllergyPromotionRequest.promotedByUserId must be positive',
            );
        }
    }

    /**
     * Idempotency-key normalization for `substance`. Lower-case +
     * trim. The service uses this both at the find-existing step and
     * at the insert step so a re-promote of "Penicillin" after the
     * first "penicillin " write hits the same row.
     */
    public function normalizedSubstance(): string
    {
        return strtolower(trim($this->substance));
    }
}
