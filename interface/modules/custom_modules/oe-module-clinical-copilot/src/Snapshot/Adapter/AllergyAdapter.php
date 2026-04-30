<?php

/**
 * Builds the allergy list for a ChartSnapshot.
 *
 * Per ARCHITECTURE.md §"Verification Architecture > Safety Rules", a
 * data-layer error is a hard stop on any medication summary; the
 * adapter does not catch — exceptions propagate to the proxy, which
 * fails the request closed.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Allergy;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class AllergyAdapter
{
    public function __construct(
        private AllergyDataSource $source,
    ) {
    }

    /**
     * @return list<Allergy>
     */
    public function fetchActive(int $pid): array
    {
        $rows = $this->source->findActiveForPid($pid);
        $out = [];
        foreach ($rows as $row) {
            $allergy = $this->mapRow($row);
            if ($allergy !== null) {
                $out[] = $allergy;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?Allergy
    {
        $substance = Normalize::toOptionalString(Normalize::stringField($row, 'title'));
        if ($substance === null) {
            return null;
        }

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        return new Allergy(
            substance: $substance,
            reaction: Normalize::toOptionalString(Normalize::stringField($row, 'reaction_title')),
            severity: Normalize::toOptionalString(Normalize::stringField($row, 'severity_al')),
            source: new SourceReference(
                system: 'openemr',
                recordType: 'AllergyIntolerance',
                recordId: $recordId,
            ),
        );
    }
}
