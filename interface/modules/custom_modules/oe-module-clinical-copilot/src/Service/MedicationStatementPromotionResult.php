<?php

/**
 * Result of a Tier-3 medication-statement promotion: the canonical UUID
 * of the new `lists` row that represents the patient-reported
 * medication in the chart.
 *
 * `idempotentHit=true` is set when the request collided with an
 * already-persisted medication keyed on
 * `(sourceDocumentUuid, normalizedDrugName)`. Used by the controller
 * to log the path; idempotency is the happy path, not a degenerate
 * one — the panel can fire accept on the same fact twice (network
 * retry) without producing a duplicate row.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

final readonly class MedicationStatementPromotionResult
{
    public function __construct(
        public string $listUuid,
        public bool $idempotentHit,
    ) {
    }
}
