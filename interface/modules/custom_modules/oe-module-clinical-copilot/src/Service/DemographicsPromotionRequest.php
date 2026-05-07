<?php

/**
 * Typed input for {@see PatientDemographicsWriteService::write()}.
 *
 * The DTO is single-field-per-call: one accept click promotes one
 * delta (address OR phone OR email), not a batch. This keeps the
 * idempotency reasoning trivial — the writer compares the current
 * column value against the incoming value and no-ops on match —
 * and matches the panel's per-field button group, which posts one
 * field per click.
 *
 * `promotedByUserId` is *not* a body field; it is sourced from the
 * verified JWT actor and supplied by the controller, mirroring the
 * F.5b–F.5e parser-boundary discipline. This prevents an
 * over-broadly minted token from spoofing a different user's
 * promotion attribution in the audit trail.
 *
 * Address shape: per F.6's "free-text pass-through" decision, the
 * agent supplies `value` as a single string (e.g. `"742 Evergreen
 * Terrace, Springfield IL 62701"`). The writer stores it verbatim
 * in `patient_data.street` without parsing into structured columns
 * (`city`, `state`, `postal_code`). Rationale lives in the
 * {@see PatientDemographicsWriteService} top-of-file comment.
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

final readonly class DemographicsPromotionRequest
{
    public function __construct(
        public int $pid,
        public string $sourceDocumentUuid,
        public DemographicsField $field,
        public string $value,
        public int $promotedByUserId,
    ) {
        if ($this->pid <= 0) {
            throw new DomainException('DemographicsPromotionRequest.pid must be positive');
        }
        if ($this->sourceDocumentUuid === '') {
            throw new DomainException(
                'DemographicsPromotionRequest.sourceDocumentUuid must be non-empty',
            );
        }
        if ($this->value === '') {
            throw new DomainException('DemographicsPromotionRequest.value must be non-empty');
        }
        if ($this->promotedByUserId <= 0) {
            throw new DomainException(
                'DemographicsPromotionRequest.promotedByUserId must be positive',
            );
        }
    }
}
