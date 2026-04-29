<?php

/**
 * ProblemListGenerator builds 'lists' table entries of type 'medical_problem'.
 *
 * Returns one problem-list row per call. The caller drives count from the
 * patient's archetype: archetype-required problems first (e.g. a diabetic
 * patient always gets E11.9), then extra weighted picks from the curated
 * pool. Required entries take precedence so the deterministic shape needed
 * by the briefing scenarios is guaranteed.
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
     * Build a problem-list row for an archetype-required condition.
     *
     * @return array<string, string|int>
     */
    public function generateRequired(int $pid, string $code, string $title): array
    {
        return $this->buildRow($pid, $code, $title);
    }

    /**
     * Build a problem-list row for a randomly-picked condition.
     *
     * @return array<string, string|int>
     */
    public function generateRandom(int $pid): array
    {
        $condition = $this->weightedPickCondition();
        return $this->buildRow($pid, $condition['code'], $condition['title']);
    }

    /**
     * @return array<string, string|int>
     */
    private function buildRow(int $pid, string $code, string $title): array
    {
        $begdate = $this->faker->dateTimeBetween('-5 years', '-1 month')->format('Y-m-d');

        return [
            'pid'       => $pid,
            'type'      => 'medical_problem',
            'title'     => $title,
            'begdate'   => $begdate,
            'enddate'   => '',
            'diagnosis' => 'ICD10:' . $code,
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
