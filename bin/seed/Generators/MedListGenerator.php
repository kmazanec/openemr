<?php

/**
 * MedListGenerator builds prescription field arrays.
 *
 * The caller passes each result to PrescriptionService::insert().
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\Seed\Generators;

use Faker\Generator as Faker;

final readonly class MedListGenerator
{
    /**
     * @var list<array{rxcui: string, name: string, dose: string, unit: string, freq: string, weight: int}>
     */
    private array $medications;

    public function __construct(private Faker $faker)
    {
        $path = __DIR__ . '/../data/common-meds.json';
        $payload = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        $this->medications = $payload['medications'];
    }

    /**
     * @return array<string, string|int>
     */
    public function generate(int $pid, int $providerId): array
    {
        $med = $this->weightedPickMed();
        $startDate = $this->faker->dateTimeBetween('-2 years', '-1 week')->format('Y-m-d');

        return [
            'patient_id'       => $pid,
            'provider_id'      => $providerId,
            'drug'             => $med['name'],
            'dosage'           => $med['dose'] . ' ' . $med['unit'],
            'rxnorm_drugcode'  => $med['rxcui'],
            'note'             => $med['freq'],
            'date_added'       => $startDate,
            'start_date'       => $startDate,
            'active'           => 1,
        ];
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
