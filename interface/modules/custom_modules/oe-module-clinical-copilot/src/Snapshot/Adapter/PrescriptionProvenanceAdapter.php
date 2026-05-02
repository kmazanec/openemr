<?php

/**
 * Builds a single {@see PrescriptionProvenance} from a prescription
 * row.
 *
 * Used by the §4.3 prescription-change branch's narrow tool. The
 * adapter intentionally does not filter `active = 1`: UC3 may ask
 * about a med that was just discontinued, and discontinuation is the
 * question's answer, not a 404.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\PrescriptionProvenance;

final readonly class PrescriptionProvenanceAdapter
{
    public function __construct(
        private PrescriptionProvenanceDataSource $source,
    ) {
    }

    public function fetchByPid(int $pid, int $prescriptionId): ?PrescriptionProvenance
    {
        $row = $this->source->findByPrescriptionId($pid, $prescriptionId);
        if ($row === null) {
            return null;
        }
        return $this->mapRow($row, $prescriptionId);
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row, int $prescriptionId): ?PrescriptionProvenance
    {
        $name = Normalize::toOptionalString(Normalize::stringField($row, 'drug'));
        if ($name === null) {
            // A prescription row with no drug name can't power a citation;
            // treat as "no record" so the controller returns 404 rather
            // than emit a partial object the verifier would reject.
            return null;
        }

        try {
            // Validates id shape; we already have $prescriptionId from the
            // caller but reading the column makes a row-id mismatch fail
            // explicitly rather than silently.
            Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        $prescribingDate = Normalize::toDateImmutable(Normalize::stringField($row, 'date_added'));
        $dose = Normalize::toOptionalString(Normalize::stringField($row, 'dosage'));

        // Single-row dose only — see DTO docblock. We surface either an
        // empty list (when both dose and date are null, there's nothing
        // documented) or a single entry mirroring the prescription row.
        $doseAdjustments = ($dose === null && $prescribingDate === null)
            ? []
            : [[
                'dose' => $dose,
                'date' => $prescribingDate?->format('Y-m-d'),
            ]];

        return new PrescriptionProvenance(
            prescriptionId: $prescriptionId,
            drugName: $name,
            prescriber: Normalize::toOptionalString(Normalize::stringField($row, 'prescriber')),
            prescribingDate: $prescribingDate,
            indication: Normalize::toOptionalString(Normalize::stringField($row, 'indication')),
            doseAdjustments: $doseAdjustments,
        );
    }
}
