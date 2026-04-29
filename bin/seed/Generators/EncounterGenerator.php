<?php

/**
 * EncounterGenerator builds form_encounter field arrays.
 *
 * Encounters are dated within the last ~3 years, biased toward more recent
 * dates so timelines look realistic without all visits clustering on one
 * day. The caller passes the result to EncounterService::insertEncounter().
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\Seed\Generators;

use Faker\Generator as Faker;

final readonly class EncounterGenerator
{
    /**
     * @var list<array{reason: string, pc_catid: int, weight: int}>
     */
    private array $templates;

    public function __construct(private Faker $faker)
    {
        $path = __DIR__ . '/../data/encounter-templates.json';
        $payload = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        $this->templates = $payload['templates'];
    }

    /**
     * @return array<string, string|int>
     */
    public function generate(int $providerId): array
    {
        $template = $this->weightedPickTemplate();
        $date = $this->faker->dateTimeBetween('-3 years', 'now')->format('Y-m-d H:i:s');

        return [
            'date'        => $date,
            'reason'      => $template['reason'],
            'pc_catid'    => $template['pc_catid'],
            'class_code'  => 'AMB',
            'provider_id' => $providerId,
            'facility_id' => 3,
            'sensitivity' => 'normal',
        ];
    }

    /**
     * @return array{reason: string, pc_catid: int, weight: int}
     */
    private function weightedPickTemplate(): array
    {
        $total = array_sum(array_column($this->templates, 'weight'));
        $roll = $this->faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach ($this->templates as $template) {
            $cumulative += $template['weight'];
            if ($roll <= $cumulative) {
                return $template;
            }
        }
        return $this->templates[0];
    }
}
