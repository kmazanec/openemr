<?php

/**
 * Builds a single {@see MedicationStatementProvenance} from a
 * `lists` + `lists_medication` row pair.
 *
 * Used by the §4.6.6 medication-statement-detail branch's narrow
 * tool. Returns null when no matching row exists (controller emits
 * 404 → branch renders "no record found"). Does not filter
 * `is_primary_record` here — the §4.6.4 snapshot adapter already
 * filters to non-primary, but UC4.6.6 may legitimately drill into
 * any entry the snapshot showed.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\MedicationStatementProvenance;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;

final readonly class MedicationStatementProvenanceAdapter
{
    public function __construct(
        private MedicationStatementProvenanceDataSource $source,
    ) {
    }

    public function fetchByPid(int $pid, int $listId): ?MedicationStatementProvenance
    {
        $row = $this->source->findByListId($pid, $listId);
        if ($row === null) {
            return null;
        }
        return $this->mapRow($row, $listId);
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row, int $listId): ?MedicationStatementProvenance
    {
        $name = Normalize::toOptionalString(Normalize::stringField($row, 'title'));
        if ($name === null) {
            // A statement row with no title can't power a citation.
            return null;
        }

        $linkedPrescriptionRaw = Normalize::intOrStringField($row, 'prescription_id');
        $linkedPrescriptionId = $linkedPrescriptionRaw === null
            ? null
            : (int) $linkedPrescriptionRaw;

        return new MedicationStatementProvenance(
            listId: $listId,
            name: $name,
            dose: Normalize::toOptionalString(
                Normalize::stringField($row, 'drug_dosage_instructions'),
            ),
            usageCategory: Normalize::toOptionalString(
                Normalize::stringField($row, 'usage_category_title'),
            ),
            informationSource: Normalize::toOptionalString(
                Normalize::stringField($row, 'information_source_title'),
            ),
            adherenceAssertedAt: Normalize::toDateImmutable(
                Normalize::stringField($row, 'medication_adherence_date_asserted'),
            ),
            startDate: Normalize::toDateImmutable(Normalize::stringField($row, 'begdate')),
            stopDate: Normalize::toDateImmutable(Normalize::stringField($row, 'enddate')),
            linkedPrescriptionId: $linkedPrescriptionId,
        );
    }
}
