<?php

/**
 * Builds the recent-external-encounter list for a ChartSnapshot.
 *
 * Reads from the `external_encounters` table populated by CCDA imports
 * (see `src/Services/Cda/CdaTemplateImportDispose.php`) and the seed
 * pipeline's `RecentEdVisit` archetype. Output coexists with native
 * encounters in {@see ChartSnapshot::$encounters}; downstream consumers
 * distinguish the two via `source.system` (`'ccda-importer'` here vs.
 * `'openemr'` from {@see EncounterAdapter}). The §4.1 follow-ups
 * generator gates the `external_care` suggestion on that exact
 * distinction.
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

final readonly class ExternalEncounterAdapter
{
    public function __construct(
        private ExternalEncounterDataSource $source,
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
                system: 'ccda-importer',
                recordType: 'Encounter',
                recordId: $recordId,
                recordedAt: $encounterDate,
            ),
        );
    }
}
