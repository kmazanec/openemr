<?php

/**
 * Builds the recent-labs list for a ChartSnapshot.
 *
 * `value` is preserved as a string (e.g. `<0.01`, `>500`, `positive`)
 * because the verifier compares the displayed claim text against the
 * source value — coercing to a numeric here would lose information the
 * verifier needs.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\LabObservation;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class ObservationAdapter
{
    public function __construct(
        private ObservationDataSource $source,
    ) {
    }

    /**
     * @return list<LabObservation>
     */
    public function fetchRecent(int $pid, int $lookbackDays): array
    {
        $rows = $this->source->findRecentForPid($pid, $lookbackDays);
        return $this->mapRows($rows);
    }

    /**
     * History rows for a single analyte over the requested lookback
     * window. Powers the agent's UC2 lab-trend tool — see
     * {@see ObservationDataSource::findHistoryByAnalyteForPid}.
     *
     * @return list<LabObservation>
     */
    public function fetchHistoryByAnalyte(
        int $pid,
        string $analyte,
        int $lookbackDays,
    ): array {
        $rows = $this->source->findHistoryByAnalyteForPid($pid, $analyte, $lookbackDays);
        return $this->mapRows($rows);
    }

    /**
     * @param  list<array<string, mixed>> $rows
     * @return list<LabObservation>
     */
    private function mapRows(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $lab = $this->mapRow($row);
            if ($lab !== null) {
                $out[] = $lab;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?LabObservation
    {
        $analyte = Normalize::toOptionalString(Normalize::stringField($row, 'analyte'));
        $value = Normalize::toOptionalString(Normalize::stringField($row, 'value'));
        if ($analyte === null || $value === null) {
            return null;
        }

        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        $observedAt = Normalize::toDateImmutable(Normalize::stringField($row, 'observed_at'));

        return new LabObservation(
            analyte: $analyte,
            value: $value,
            unit: Normalize::toOptionalString(Normalize::stringField($row, 'units')),
            referenceRange: Normalize::toOptionalString(Normalize::stringField($row, 'range')),
            abnormalFlag: Normalize::toOptionalString(Normalize::stringField($row, 'abnormal')),
            observedAt: $observedAt,
            source: new SourceReference(
                system: 'openemr',
                recordType: 'Observation',
                recordId: $recordId,
                recordedAt: $observedAt,
            ),
        );
    }
}
