<?php

/**
 * ProblemListGenerator builds 'lists' table entries of type 'medical_problem'.
 *
 * Each call returns one problem-list row. The caller decides how many to
 * generate per patient (typically 0–3 per Level-2 patient).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\Seed\Generators;

use Faker\Generator as Faker;

final readonly class ProblemListGenerator
{
    /**
     * @var list<array{code: string, title: string, weight: int}>
     */
    private array $conditions;

    public function __construct(private Faker $faker)
    {
        $path = __DIR__ . '/../data/common-conditions.json';
        $payload = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        $this->conditions = $payload['conditions'];
    }

    /**
     * @return array<string, string|int>
     */
    public function generate(int $pid): array
    {
        $condition = $this->weightedPickCondition();
        $begdate = $this->faker->dateTimeBetween('-5 years', '-1 month')->format('Y-m-d');

        return [
            'pid'       => $pid,
            'type'      => 'medical_problem',
            'title'     => $condition['title'],
            'begdate'   => $begdate,
            'enddate'   => '',
            'diagnosis' => 'ICD10:' . $condition['code'],
        ];
    }

    /**
     * @return array{code: string, title: string, weight: int}
     */
    private function weightedPickCondition(): array
    {
        $total = array_sum(array_column($this->conditions, 'weight'));
        $roll = $this->faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach ($this->conditions as $condition) {
            $cumulative += $condition['weight'];
            if ($roll <= $cumulative) {
                return $condition;
            }
        }
        return $this->conditions[0];
    }
}
