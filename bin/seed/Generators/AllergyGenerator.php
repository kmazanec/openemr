<?php

/**
 * AllergyGenerator builds 'lists' table entries of type 'allergy'.
 *
 * USERS.md flags allergies as "always surfaced, never omitted" in the
 * default briefing — so seed data must populate them. ~35% of patients get
 * 1-2 allergies; the rest stay blank (which is itself a meaningful state
 * the agent should render as "NKDA").
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

final readonly class AllergyGenerator
{
    /** @var list<array{title: string, reaction: string, weight: int}> */
    private const ALLERGENS = [
        ['title' => 'Penicillin', 'reaction' => 'Hives', 'weight' => 30],
        ['title' => 'Sulfa drugs', 'reaction' => 'Rash', 'weight' => 18],
        ['title' => 'NSAIDs', 'reaction' => 'GI upset', 'weight' => 12],
        ['title' => 'Codeine', 'reaction' => 'Nausea', 'weight' => 10],
        ['title' => 'Latex', 'reaction' => 'Contact dermatitis', 'weight' => 8],
        ['title' => 'Peanuts', 'reaction' => 'Anaphylaxis', 'weight' => 7],
        ['title' => 'Shellfish', 'reaction' => 'Hives, swelling', 'weight' => 6],
        ['title' => 'Iodine / contrast', 'reaction' => 'Rash', 'weight' => 5],
        ['title' => 'Bee stings', 'reaction' => 'Localized swelling', 'weight' => 4],
    ];

    public function __construct(private Faker $faker)
    {
    }

    /**
     * Build one allergy lists row suitable for ListService::insert(). Returns
     * null when the patient should have no allergy recorded at all.
     *
     * @return array<string, string|int>
     */
    public function generate(int $pid): array
    {
        $allergen = $this->weightedPick();
        $begdate = $this->faker->dateTimeBetween('-15 years', '-30 days')->format('Y-m-d');

        return [
            'pid'       => $pid,
            'type'      => 'allergy',
            'title'     => $allergen['title'],
            'begdate'   => $begdate,
            'enddate'   => '',
            'diagnosis' => '',
            'reaction'  => $allergen['reaction'],
            'severity_al' => $this->faker->randomElement(['mild', 'moderate', 'severe']),
        ];
    }

    /**
     * @return array{title: string, reaction: string, weight: int}
     */
    private function weightedPick(): array
    {
        $total = array_sum(array_column(self::ALLERGENS, 'weight'));
        $roll = $this->faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach (self::ALLERGENS as $allergen) {
            $cumulative += $allergen['weight'];
            if ($roll <= $cumulative) {
                return $allergen;
            }
        }
        return self::ALLERGENS[0];
    }
}
