<?php

/**
 * LabResultGenerator builds time-series lab orders + reports + results for
 * a patient based on their archetype.
 *
 * The result is a list of "lab series" — each series is one panel ordered
 * over time at archetype-appropriate cadence:
 *
 *   - Diabetic: A1c every ~6 months × 3, controlled (6.5-7.2)
 *   - DiabeticUncontrolled: A1c every ~6 months × 3, walking 7.0 → 7.6 → 8.2.
 *     This is the demoable population for UC2's "A1c rose to 8.2" briefing.
 *   - Hypertensive / ComplexElderly: lipid panel + CMP at annual cadence × 2
 *   - RecentEdVisit: one CMP from the recent ED visit (~2-4 weeks ago)
 *   - HealthyAdult: one annual CMP
 *
 * ~15% of patients (across archetypes, opportunistic) get a recent (<90d)
 * abnormal value bolted on so UC1's "new abnormal labs" delta has something
 * to render. The opportunistic abnormal is added by the seed command, not
 * here, by calling generateOpportunisticAbnormal().
 *
 * The generator returns plain arrays — the seed command does the actual
 * INSERTs through QueryUtils since there's no write-side service for the
 * procedure_* tables.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed\Generators;

use Faker\Generator as Faker;
use OpenEMR\Seed\PatientArchetype;

final readonly class LabResultGenerator
{
    /**
     * @var array<string, array{code: string, name: string, panel_type: string, specimen_type: string, tests: list<array{loinc: string, name: string, units: string, normal_low: float, normal_high: float, decimals: int}>}>
     */
    private array $panelsByCode;

    public function __construct(private Faker $faker)
    {
        $path = __DIR__ . '/../data/lab-templates.json';
        $payload = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        $byCode = [];
        foreach ($payload['panels'] as $panel) {
            $byCode[$panel['code']] = $panel;
        }
        $this->panelsByCode = $byCode;
    }

    /**
     * Build the full lab series for a patient. Returns a list of "panels"
     * each with one or more dated draws. Caller iterates and inserts each
     * draw as one procedure_order/report row + one procedure_result row
     * per test in the panel.
     *
     * @return list<LabSeries>
     */
    public function generateForArchetype(PatientArchetype $archetype): array
    {
        return match ($archetype) {
            PatientArchetype::HealthyAdult => [
                $this->buildSeries('24323-8', $this->annualDraws(1), fn() => null),
            ],
            PatientArchetype::Hypertensive => [
                $this->buildSeries('57698-3', $this->annualDraws(2), fn(int $i) => $this->lipidShape($i, false)),
                $this->buildSeries('24323-8', $this->annualDraws(2), fn() => null),
            ],
            PatientArchetype::Diabetic => [
                $this->buildSeries('4548-4', $this->halfYearDraws(3), fn(int $i) => $this->a1cControlled()),
                $this->buildSeries('57698-3', $this->annualDraws(2), fn(int $i) => $this->lipidShape($i, true)),
            ],
            PatientArchetype::DiabeticUncontrolled => [
                $this->buildSeries('4548-4', $this->halfYearDraws(3), fn(int $i) => $this->a1cWorsening($i)),
                $this->buildSeries('57698-3', $this->annualDraws(2), fn(int $i) => $this->lipidShape($i, true)),
                $this->buildSeries('24323-8', $this->halfYearDraws(2), fn() => null),
            ],
            PatientArchetype::ComplexElderly => [
                $this->buildSeries('57698-3', $this->annualDraws(2), fn(int $i) => $this->lipidShape($i, true)),
                $this->buildSeries('24323-8', $this->annualDraws(2), fn() => null),
            ],
            PatientArchetype::RecentEdVisit => [
                $this->buildSeries('24323-8', [$this->daysAgo($this->faker->numberBetween(14, 28))], fn() => null),
            ],
        };
    }

    /**
     * Generate a single recent abnormal CMP (last 30-90 days) — for the
     * ~15% subset that should pop UC1's "recent abnormal" slot. Returns
     * null if the random roll says skip.
     */
    public function generateOpportunisticAbnormal(): ?LabSeries
    {
        if ($this->faker->numberBetween(1, 100) > 15) {
            return null;
        }
        $when = $this->daysAgo($this->faker->numberBetween(30, 90));
        return $this->buildSeries('24323-8', [$when],
            // Force one CMP component to be abnormal. Keep it clinically
            // plausible: elevated glucose or creatinine is the most likely
            // surprise result in this population.
            fn(): array => [
            '1558-6' => ['value' => $this->faker->numberBetween(115, 145), 'abnormal' => 'high'],
        ]);
    }

    /**
     * @param list<\DateTimeImmutable> $drawDates
     * @param callable(int): ?array<string, array{value: int|float, abnormal?: string}> $perDrawOverrides
     *        Returns LOINC-keyed value+abnormal overrides for drawDates[i],
     *        or null to take the random per-test default.
     */
    private function buildSeries(string $panelCode, array $drawDates, callable $perDrawOverrides): LabSeries
    {
        $panel = $this->panelsByCode[$panelCode];
        $draws = [];
        foreach ($drawDates as $idx => $date) {
            $overrides = $perDrawOverrides($idx) ?? [];
            $results = [];
            foreach ($panel['tests'] as $test) {
                $override = $overrides[$test['loinc']] ?? null;
                if ($override !== null) {
                    $value = $override['value'];
                    $abnormal = $override['abnormal'] ?? $this->classifyAbnormal((float) $value, $test);
                } else {
                    $value = $this->randomNormalValue($test);
                    $abnormal = $this->classifyAbnormal((float) $value, $test);
                }
                $results[] = [
                    'loinc'   => $test['loinc'],
                    'name'    => $test['name'],
                    'units'   => $test['units'],
                    'range'   => $this->formatRange($test),
                    'value'   => $this->formatValue($value, $test['decimals']),
                    'abnormal' => $abnormal,
                ];
            }
            $draws[] = new LabDraw($date, $results);
        }
        return new LabSeries($panel['code'], $panel['name'], $panel['specimen_type'], $draws);
    }

    /** @return list<\DateTimeImmutable> */
    private function annualDraws(int $count): array
    {
        $dates = [];
        for ($i = 0; $i < $count; $i++) {
            // Most recent first walking back roughly one year per step.
            $monthsAgo = ($i * 12) + $this->faker->numberBetween(0, 3);
            $dates[] = $this->daysAgo($monthsAgo * 30);
        }
        // Generator semantics: callers expect oldest → newest so trends read left to right.
        return array_reverse($dates);
    }

    /** @return list<\DateTimeImmutable> */
    private function halfYearDraws(int $count): array
    {
        $dates = [];
        for ($i = 0; $i < $count; $i++) {
            $monthsAgo = ($i * 6) + $this->faker->numberBetween(0, 2);
            $dates[] = $this->daysAgo($monthsAgo * 30);
        }
        return array_reverse($dates);
    }

    private function daysAgo(int $days): \DateTimeImmutable
    {
        return (new \DateTimeImmutable('today'))->modify("-{$days} days");
    }

    /**
     * A1c series for a controlled diabetic — values bounce 6.5-7.2.
     *
     * @return array<string, array{value: int|float, abnormal: string}>
     */
    private function a1cControlled(): array
    {
        $value = round($this->faker->randomFloat(1, 6.5, 7.2), 1);
        return ['4548-4' => ['value' => $value, 'abnormal' => 'high']];
    }

    /**
     * A1c series walking from controlled to uncontrolled. Index 0 is the
     * oldest draw (best-controlled), index 2 is most recent (worst).
     *
     * @return array<string, array{value: int|float, abnormal: string}>
     */
    private function a1cWorsening(int $idx): array
    {
        $bands = [
            0 => [6.8, 7.2],
            1 => [7.4, 7.8],
            2 => [8.0, 8.5],
        ];
        $band = $bands[$idx] ?? [7.5, 8.0];
        $value = round($this->faker->randomFloat(1, $band[0], $band[1]), 1);
        return ['4548-4' => ['value' => $value, 'abnormal' => 'high']];
    }

    /**
     * Lipid panel: optionally bias LDL high for diabetics/elderly so
     * "borderline-high LDL" shows up in the briefing.
     *
     * @return array<string, array{value: int|float, abnormal?: string}>
     */
    private function lipidShape(int $idx, bool $biasHighLdl): array
    {
        if ($biasHighLdl && $this->faker->numberBetween(1, 100) <= 60) {
            return [
                '13457-7' => ['value' => $this->faker->numberBetween(110, 145), 'abnormal' => 'high'],
            ];
        }
        return [];
    }

    /**
     * @param array{normal_low: float, normal_high: float, decimals: int} $test
     * @return int|float
     */
    private function randomNormalValue(array $test)
    {
        $low = $test['normal_low'];
        $high = $test['normal_high'];
        // 80% of the time stay in range; 20% drift slightly outside so the
        // chart isn't suspiciously perfect.
        if ($this->faker->numberBetween(1, 100) <= 80) {
            return $this->faker->randomFloat($test['decimals'], $low, $high);
        }
        $spread = ($high - $low) * 0.15;
        return $this->faker->randomFloat($test['decimals'], $low - $spread, $high + $spread);
    }

    /**
     * @param array{normal_low: float, normal_high: float} $test
     */
    private function classifyAbnormal(float $value, array $test): string
    {
        if ($value < $test['normal_low']) {
            return 'low';
        }
        if ($value > $test['normal_high']) {
            return 'high';
        }
        return 'no';
    }

    /**
     * @param array{normal_low: float, normal_high: float, decimals: int} $test
     */
    private function formatRange(array $test): string
    {
        return sprintf(
            "%s-%s",
            $this->formatValue($test['normal_low'], $test['decimals']),
            $this->formatValue($test['normal_high'], $test['decimals']),
        );
    }

    /**
     * @param int|float $value
     */
    private function formatValue($value, int $decimals): string
    {
        return number_format((float) $value, $decimals, '.', '');
    }
}
