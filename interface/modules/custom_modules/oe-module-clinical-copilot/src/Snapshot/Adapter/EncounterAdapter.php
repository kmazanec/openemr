<?php

/**
 * Builds the recent-encounter list for a ChartSnapshot.
 *
 * Carries date / type / reason only — full SOAP / progress notes are
 * deliberately excluded in v1 (ARCHITECTURE.md §"ChartSnapshot").
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Encounter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class EncounterAdapter
{
    public function __construct(
        private EncounterDataSource $source,
    ) {
    }

    /**
     * @return list<Encounter>
     */
    public function fetchRecent(int $pid, int $lookbackDays): array
    {
        $rows = $this->source->findRecentForPid($pid, $lookbackDays);
        $out = [];
        foreach ($rows as $row) {
            $encounter = $this->mapRow($row);
            if ($encounter !== null) {
                $out[] = $encounter;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?Encounter
    {
        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'encounter'));
        } catch (DomainException) {
            return null;
        }

        $encounterDate = Normalize::toDateImmutable(Normalize::stringField($row, 'encounter_date'));

        return new Encounter(
            encounterDate: $encounterDate,
            type: Normalize::toOptionalString(Normalize::stringField($row, 'encounter_type')),
            reason: Normalize::toOptionalString(Normalize::stringField($row, 'reason')),
            source: new SourceReference(
                system: 'openemr',
                recordType: 'Encounter',
                recordId: $recordId,
                recordedAt: $encounterDate,
            ),
        );
    }
}
