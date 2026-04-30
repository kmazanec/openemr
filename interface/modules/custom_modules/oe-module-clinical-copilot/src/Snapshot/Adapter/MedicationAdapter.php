<?php

/**
 * Builds the active medication list for a ChartSnapshot.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Medication;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class MedicationAdapter
{
    public function __construct(
        private MedicationDataSource $source,
    ) {
    }

    /**
     * @return list<Medication>
     */
    public function fetchActive(int $pid): array
    {
        $rows = $this->source->findActiveForPid($pid);
        $out = [];
        foreach ($rows as $row) {
            $med = $this->mapRow($row);
            if ($med !== null) {
                $out[] = $med;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?Medication
    {
        $name = Normalize::toOptionalString(Normalize::stringField($row, 'drug'));
        if ($name === null) {
            return null;
        }

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        $startDate = Normalize::toDateImmutable(Normalize::stringField($row, 'date_added'));

        return new Medication(
            name: $name,
            dose: Normalize::toOptionalString(Normalize::stringField($row, 'dosage')),
            route: Normalize::toOptionalString(Normalize::stringField($row, 'route_title')),
            frequency: Normalize::toOptionalString(Normalize::stringField($row, 'interval_title')),
            startDate: $startDate,
            // stopDate intentionally null: this adapter only surfaces
            // active prescriptions (production query filters active = 1),
            // and prescriptions has no explicit discontinuation column —
            // date_modified is the last-edit timestamp, which is wrong
            // for stopDate (a typo fix would falsely "stop" the med).
            // When inactive meds are surfaced, source this from a real
            // stop column.
            stopDate: null,
            prescriber: Normalize::toOptionalString(Normalize::stringField($row, 'prescriber')),
            source: new SourceReference(
                system: 'openemr',
                recordType: 'MedicationRequest',
                recordId: $recordId,
                recordedAt: $startDate,
            ),
        );
    }
}
