<?php

/**
 * Builds the active-diagnosis list for a ChartSnapshot.
 *
 * OpenEMR encodes the code system as a prefix in `lists.diagnosis`
 * (`ICD10:E11.9`, `ICD9:250.00`, etc.). The adapter splits the prefix
 * off and normalizes to a hyphenated label so the LLM doesn't have to
 * guess.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Diagnosis;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class ConditionAdapter
{
    public function __construct(
        private ConditionDataSource $source,
    ) {
    }

    /**
     * @return list<Diagnosis>
     */
    public function fetchActive(int $pid): array
    {
        $rows = $this->source->findActiveForPid($pid);
        $out = [];
        foreach ($rows as $row) {
            $diagnosis = $this->mapRow($row);
            if ($diagnosis !== null) {
                $out[] = $diagnosis;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?Diagnosis
    {
        $coded = self::parseCodedDiagnosis(Normalize::stringField($row, 'diagnosis'));
        if ($coded === null) {
            return null;
        }
        $label = Normalize::stringField($row, 'title') ?? $coded['code'];

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        $onset = Normalize::toDateImmutable(Normalize::stringField($row, 'date'));

        return new Diagnosis(
            code: $coded['code'],
            codeSystem: $coded['codeSystem'],
            label: $label,
            onsetDate: $onset,
            source: new SourceReference(
                sourceType: 'chart',
                sourceId: $recordId,
                locator: ['field' => 'condition.code'],
                quote: $coded['code'],
                meta: $onset !== null ? ['record_recorded_at' => $onset->format('Y-m-d')] : null,
            ),
        );
    }

    /**
     * @return ?array{code: string, codeSystem: string}
     */
    private static function parseCodedDiagnosis(?string $raw): ?array
    {
        $value = Normalize::toOptionalString($raw);
        if ($value === null) {
            return null;
        }
        // OpenEMR can encode multiple codes separated by `;`; take the
        // first — the citation links back to the row, which carries the
        // full string for any consumer that needs it.
        $first = explode(';', $value)[0];
        $parts = explode(':', $first, 2);
        if (count($parts) !== 2) {
            return null;
        }
        $system = self::canonicalCodeSystem($parts[0]);
        $code = trim($parts[1]);
        if ($system === null || $code === '') {
            return null;
        }
        return ['code' => $code, 'codeSystem' => $system];
    }

    private static function canonicalCodeSystem(string $prefix): ?string
    {
        return match (strtoupper(trim($prefix))) {
            'ICD10', 'ICD-10', 'ICD10CM', 'ICD-10-CM' => 'ICD-10',
            'ICD9', 'ICD-9', 'ICD9CM', 'ICD-9-CM' => 'ICD-9',
            'SNOMED', 'SNOMED-CT', 'SNOMEDCT' => 'SNOMED-CT',
            default => null,
        };
    }
}
