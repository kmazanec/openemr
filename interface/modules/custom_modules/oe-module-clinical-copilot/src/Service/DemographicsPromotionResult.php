<?php

/**
 * Result of a Tier-3 demographics-delta promotion: the patient's
 * UUID (so the panel can re-fetch the canonical record) plus
 * `idempotentHit=true` when the chart's current column value
 * already equals the requested value.
 *
 * Demographics promotions don't mint a new chart record (unlike the
 * F.5b–F.5e list-shaped writes); they update an existing
 * `patient_data` row in place. The "chart record" returned to the
 * panel is the patient's own UUID — there's no fresher identifier
 * to surface, and the panel uses it only for the disclosure link
 * back to `source_document_uuid`.
 *
 * `idempotentHit=true` is set when the requested value already
 * matches what's stored — re-promoting "742 Evergreen Terrace" when
 * the chart already says "742 Evergreen Terrace" is a no-op, and
 * the panel can fire accept on the same delta twice (network retry)
 * without producing a spurious audit entry.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

final readonly class DemographicsPromotionResult
{
    public function __construct(
        public string $patientUuid,
        public bool $idempotentHit,
    ) {
    }
}
