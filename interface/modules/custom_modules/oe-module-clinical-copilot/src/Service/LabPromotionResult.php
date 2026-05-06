<?php

/**
 * Result of a Tier-3 lab promotion: the canonical UUID of the new
 * `procedure_report` row plus the canonical UUIDs of every
 * `procedure_result` row written under it. Both shapes are returned
 * verbatim on idempotent re-call so the caller cannot distinguish
 * "wrote new" from "found existing".
 *
 * `idempotentHit=true` is set when the request collided with an
 * already-persisted panel keyed on
 * `(sourceDocumentUuid, panelCode, collectionDate)`. Used by the
 * controller to log the path and (optionally) emit a different
 * disclosure shape, never as a hard error: idempotency is the
 * happy path, not a degenerate one.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

final readonly class LabPromotionResult
{
    /**
     * @param non-empty-list<string> $observationUuids 36-char canonical UUIDs, one per analyte.
     */
    public function __construct(
        public string $diagnosticReportUuid,
        public array $observationUuids,
        public bool $idempotentHit,
    ) {
    }
}
