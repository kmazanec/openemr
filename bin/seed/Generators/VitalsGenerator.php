<?php

/**
 * VitalsGenerator builds form_vitals payloads tied to an encounter.
 *
 * Uses a per-patient baseline (drawn from the archetype) so trends are
 * coherent across encounters: a hypertensive patient's BPs cluster 138-148,
 * not random across the whole adult range. UC1's "what's notable" prioritizing
 * and UC2's BP-trend drill-down both depend on this coherence.
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

final readonly class VitalsGenerator
{
    public function __construct(private Faker $faker)
    {
    }

    /**
     * Build a form_vitals payload. Caller passes to VitalsService::save().
     *
     * Heights are stable across the patient's history; weight drifts a few
     * pounds; BP and pulse jitter around the archetype baseline.
     *
     * @return array<string, string|int|float>
     */
    public function generate(
        int $pid,
        int $encounterId,
        string $encounterDateTime,
        PatientArchetype $archetype,
        float $stableHeightInches,
        float $baselineWeightLbs,
    ): array {
        $baseline = $archetype->vitalsBaseline();

        $bps = $baseline['bps'] + $this->faker->numberBetween(-8, 8);
        $bpd = $baseline['bpd'] + $this->faker->numberBetween(-5, 5);
        $weight = round($baselineWeightLbs + $this->faker->randomFloat(1, -3, 3), 1);
        $heightMeters = ($stableHeightInches * 0.0254);
        $bmi = $heightMeters > 0
            ? round(($weight * 0.45359237) / ($heightMeters * $heightMeters), 1)
            : $baseline['bmi'];
        $pulse = 72 + $this->faker->numberBetween(-10, 14);

        return [
            'pid'         => $pid,
            'eid'         => $encounterId,
            'date'        => $encounterDateTime,
            'authorized'  => 1,
            'bps'         => (string) $bps,
            'bpd'         => (string) $bpd,
            'height'      => (string) $stableHeightInches,
            'weight'      => (string) $weight,
            'pulse'       => (string) $pulse,
            'temperature' => (string) round(98.0 + $this->faker->randomFloat(1, 0, 1.6), 1),
            'respiration' => (string) $this->faker->numberBetween(14, 20),
            'BMI'         => (string) $bmi,
            'oxygen_saturation' => (string) $this->faker->numberBetween(96, 100),
        ];
    }
}
