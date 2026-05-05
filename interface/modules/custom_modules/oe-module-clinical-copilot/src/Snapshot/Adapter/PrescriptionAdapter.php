<?php

/**
 * Builds the prescription list for a ChartSnapshot — active rows plus
 * inactive rows modified within the lookback window.
 *
 * Sourced from OpenEMR's `prescriptions` table (FHIR
 * `MedicationRequest`). Distinct from `MedicationStatement` (Phase
 * 4.6.4) which captures patient-reported / OTC entries.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Prescription;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class PrescriptionAdapter
{
    /**
     * Default lookback for inactive scripts in the briefing snapshot.
     * Matches `AgentSnapshotController::DEFAULT_LOOKBACK_DAYS` so all
     * snapshot temporal scopes (labs, encounters, prescriptions) stay
     * in lockstep.
     */
    public const DEFAULT_LOOKBACK_DAYS = 365;

    public function __construct(
        private PrescriptionDataSource $source,
    ) {
    }

    /**
     * @return list<Prescription>
     */
    public function fetchRecent(int $pid, int $lookbackDays = self::DEFAULT_LOOKBACK_DAYS): array
    {
        $rows = $this->source->findRecentForPid($pid, $lookbackDays);
        $out = [];
        foreach ($rows as $row) {
            $rx = $this->mapRow($row);
            if ($rx !== null) {
                $out[] = $rx;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?Prescription
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

        // stopDate populates from `date_modified` only when active = 0
        // (genuinely stopped). For active rows, date_modified moves on
        // benign edits (typo fixes, route corrections), so using it
        // would falsely "stop" the med. The DTO comments this rule.
        // Missing/non-numeric `active` defaults to active=1 (the column
        // default in `prescriptions`); only an explicit zero flips
        // stopDate on.
        $activeRaw = Normalize::intOrStringField($row, 'active');
        $isActive = $activeRaw === null || (int) $activeRaw === 1;
        $stopDate = $isActive
            ? null
            : Normalize::toDateImmutable(Normalize::stringField($row, 'date_modified'));

        return new Prescription(
            name: $name,
            dose: Normalize::toOptionalString(Normalize::stringField($row, 'dosage')),
            route: Normalize::toOptionalString(Normalize::stringField($row, 'route_title')),
            frequency: Normalize::toOptionalString(Normalize::stringField($row, 'interval_title')),
            startDate: $startDate,
            stopDate: $stopDate,
            prescriber: Normalize::toOptionalString(Normalize::stringField($row, 'prescriber')),
            indication: Normalize::toOptionalString(Normalize::stringField($row, 'indication')),
            prescriptionId: (int) $recordId,
            source: new SourceReference(
                sourceType: 'chart',
                sourceId: $recordId,
                locator: ['field' => 'medication.name'],
                quote: $name,
                meta: $startDate !== null ? ['record_recorded_at' => $startDate->format('Y-m-d')] : null,
            ),
        );
    }
}
