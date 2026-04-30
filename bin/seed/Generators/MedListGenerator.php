<?php

/**
 * MedListGenerator builds prescription field arrays.
 *
 * Returns one med per call. Like ProblemListGenerator, callers can request
 * a specific medication (archetype-required, e.g. metformin for diabetics)
 * or a weighted random pick from the curated pool. The caller passes each
 * result to PrescriptionService::insert().
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

final readonly class MedListGenerator
{
    /**
     * @var list<array{rxcui: string, name: string, dose: string, unit: string, freq: string, weight: int}>
     */
    private array $medications;

    /** @var array<string, array{rxcui: string, name: string, dose: string, unit: string, freq: string, weight: int}> */
    private array $medsByRxcui;

    public function __construct(private Faker $faker)
    {
        $path = __DIR__ . '/../data/common-meds.json';
        $payload = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        $this->medications = $payload['medications'];

        $byRxcui = [];
        foreach ($this->medications as $med) {
            $byRxcui[$med['rxcui']] = $med;
        }
        $this->medsByRxcui = $byRxcui;
    }

    /**
     * Build a prescription row for an archetype-required medication.
     * Caller can pin start_date (e.g. to a synthesized prescribing
     * encounter date) and indication text — both surface in UC3's
     * "when/why was lisinopril started" drill-down.
     *
     * @return array<string, string|int>
     */
    public function generateByRxcui(
        int $pid,
        int $providerId,
        string $rxcui,
        ?string $startDate = null,
        ?string $indication = null,
    ): array {
        if (!isset($this->medsByRxcui[$rxcui])) {
            throw new \InvalidArgumentException("Unknown rxcui '{$rxcui}' in seed med catalog");
        }
        return $this->buildRow($pid, $providerId, $this->medsByRxcui[$rxcui], $startDate, $indication);
    }

    /**
     * Build a prescription row for a randomly-picked medication.
     *
     * @return array<string, string|int>
     */
    public function generateRandom(int $pid, int $providerId): array
    {
        return $this->buildRow($pid, $providerId, $this->weightedPickMed(), null, null);
    }

    /**
     * Mutate a prescription row to represent a recently-stopped med —
     * sets active=0 and end_date in the recent past so UC1's
     * "deltas since last visit" briefing slot has stops to surface.
     *
     * @param array<string, string|int> $row
     * @return array<string, string|int>
     */
    public function markStopped(array $row): array
    {
        $endDate = $this->faker->dateTimeBetween('-90 days', '-15 days')->format('Y-m-d');
        $row['active'] = 0;
        $row['end_date'] = $endDate;
        return $row;
    }

    /**
     * @param array{rxcui: string, name: string, dose: string, unit: string, freq: string, weight: int} $med
     * @return array<string, string|int>
     */
    private function buildRow(
        int $pid,
        int $providerId,
        array $med,
        ?string $startDate,
        ?string $indication,
    ): array {
        $start = $startDate ?? $this->faker->dateTimeBetween('-2 years', '-1 week')->format('Y-m-d');

        $row = [
            'patient_id'       => $pid,
            'provider_id'      => $providerId,
            'drug'             => $med['name'],
            'dosage'           => $med['dose'] . ' ' . $med['unit'],
            'rxnorm_drugcode'  => $med['rxcui'],
            'note'             => $med['freq'],
            'date_added'       => $start,
            'start_date'       => $start,
            'active'           => 1,
        ];
        if ($indication !== null) {
            $row['indication'] = $indication;
        }
        return $row;
    }

    /**
     * @return array{rxcui: string, name: string, dose: string, unit: string, freq: string, weight: int}
     */
    private function weightedPickMed(): array
    {
        $total = array_sum(array_column($this->medications, 'weight'));
        $roll = $this->faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach ($this->medications as $med) {
            $cumulative += $med['weight'];
            if ($roll <= $cumulative) {
                return $med;
            }
        }
        return $this->medications[0];
    }
}
