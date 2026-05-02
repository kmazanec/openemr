<?php

/**
 * Builds the patient-reported medication list (FHIR
 * `MedicationStatement`) for a ChartSnapshot.
 *
 * Sourced from `lists` (`type='medication'`) joined to
 * `lists_medication` (`is_primary_record=0`). Distinct from
 * {@see PrescriptionAdapter} which surfaces the clinic's
 * `prescriptions` table.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\MedicationStatement;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class MedicationStatementAdapter
{
    public function __construct(
        private MedicationStatementDataSource $source,
    ) {
    }

    /**
     * @return list<MedicationStatement>
     */
    public function fetchActive(int $pid): array
    {
        $rows = $this->source->findActiveForPid($pid);
        $out = [];
        foreach ($rows as $row) {
            $stmt = $this->mapRow($row);
            if ($stmt !== null) {
                $out[] = $stmt;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?MedicationStatement
    {
        // `lists.title` carries the medication name. Without it, the
        // verifier has nothing to match on, so drop the row.
        $name = Normalize::toOptionalString(Normalize::stringField($row, 'title'));
        if ($name === null) {
            return null;
        }

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        return new MedicationStatement(
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
            startDate: Normalize::toDateImmutable(Normalize::stringField($row, 'begdate')),
            stopDate: Normalize::toDateImmutable(Normalize::stringField($row, 'enddate')),
            listId: (int) $recordId,
            source: new SourceReference(
                system: 'openemr',
                recordType: 'MedicationStatement',
                recordId: $recordId,
                recordedAt: Normalize::toDateImmutable(
                    Normalize::stringField($row, 'date'),
                ),
            ),
        );
    }
}
