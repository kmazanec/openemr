<?php

/**
 * Builds the recent-vitals list for a ChartSnapshot follow-up.
 *
 * Numeric fields are preserved as strings (no float coercion) for the
 * same reason {@see ObservationAdapter} preserves lab values: the
 * verifier compares displayed claim text against the source string,
 * and float coercion would lose trailing zeros and source-side rounding.
 *
 * `fetchHistory()` returns rows for a single vital column over a longer
 * lookback so the agent can answer "is this patient's BP trending
 * down?" — analogous to {@see ObservationAdapter::fetchHistoryByAnalyte}
 * for labs.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\VitalSign;

final readonly class VitalsAdapter
{
    /**
     * Map of public-facing vital-type tokens (what the agent sends) to
     * the underlying `form_vitals` column. The controller MUST validate
     * a caller-supplied vital type against this allowlist before reaching
     * the data source — both because column names are not user input and
     * because the SQL builder interpolates the column directly.
     *
     * @var array<string, string>
     */
    public const VITAL_TYPES = [
        'systolic_bp' => 'bps',
        'diastolic_bp' => 'bpd',
        'pulse' => 'pulse',
        'respiration' => 'respiration',
        'temperature' => 'temperature',
        'weight' => 'weight',
        'height' => 'height',
        'bmi' => 'BMI',
        'oxygen_saturation' => 'oxygen_saturation',
    ];

    public function __construct(
        private VitalsDataSource $source,
    ) {
    }

    /**
     * @return list<VitalSign>
     */
    public function fetchRecent(int $pid, int $lookbackDays): array
    {
        $rows = $this->source->findRecentForPid($pid, $lookbackDays);
        return $this->mapRows($rows);
    }

    /**
     * History rows for a single vital type. `$vitalType` must be one of
     * the keys in {@see self::VITAL_TYPES}; the controller is responsible
     * for validating before this method is reached.
     *
     * @return list<VitalSign>
     */
    public function fetchHistory(int $pid, string $vitalType, int $lookbackDays): array
    {
        $rows = $this->source->findHistoryByVitalTypeForPid($pid, $vitalType, $lookbackDays);
        return $this->mapRows($rows);
    }

    /**
     * @param  list<array<string, mixed>> $rows
     * @return list<VitalSign>
     */
    private function mapRows(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $vital = $this->mapRow($row);
            if ($vital !== null) {
                $out[] = $vital;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row): ?VitalSign
    {
        try {
            $recordId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        $observedAt = Normalize::toDateImmutable(Normalize::stringField($row, 'observed_at'));

        $vital = new VitalSign(
            observedAt: $observedAt,
            bpSystolic: self::numericString($row, 'bps'),
            bpDiastolic: self::numericString($row, 'bpd'),
            pulse: self::numericString($row, 'pulse'),
            respiration: self::numericString($row, 'respiration'),
            temperatureF: self::numericString($row, 'temperature'),
            weightLbs: self::numericString($row, 'weight'),
            heightInches: self::numericString($row, 'height'),
            bmi: self::numericString($row, 'BMI'),
            oxygenSaturation: self::numericString($row, 'oxygen_saturation'),
            source: new SourceReference(
                sourceType: 'chart',
                sourceId: $recordId,
                locator: ['field' => 'observation.value'],
                quote: $observedAt?->format('Y-m-d') ?? 'vitals',
                meta: $observedAt !== null ? ['record_recorded_at' => $observedAt->format('Y-m-d')] : null,
            ),
        );

        if (!self::hasAnyValue($vital)) {
            // A row that recorded no vital fields at all is noise from
            // empty inserts; drop so the verifier never sees a citation
            // pointing to a row with nothing to cite.
            return null;
        }

        return $vital;
    }

    /**
     * `form_vitals` zero-fills numeric columns ("0.000000") when the
     * field wasn't measured. Treat any row whose value parses as 0
     * (after trimming) as missing — matching how the OpenEMR UI does.
     *
     * @param array<string, mixed> $row
     */
    private static function numericString(array $row, string $key): ?string
    {
        $raw = Normalize::stringField($row, $key);
        $value = Normalize::toOptionalString($raw);
        if ($value === null) {
            return null;
        }
        if (is_numeric($value) && (float) $value === 0.0) {
            return null;
        }
        return $value;
    }

    private static function hasAnyValue(VitalSign $vital): bool
    {
        return $vital->bpSystolic !== null
            || $vital->bpDiastolic !== null
            || $vital->pulse !== null
            || $vital->respiration !== null
            || $vital->temperatureF !== null
            || $vital->weightLbs !== null
            || $vital->heightInches !== null
            || $vital->bmi !== null
            || $vital->oxygenSaturation !== null;
    }
}
