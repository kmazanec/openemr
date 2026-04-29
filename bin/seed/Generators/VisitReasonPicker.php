<?php

/**
 * VisitReasonPicker centralises archetype-aware reason selection. Both
 * past encounters (form_encounter.reason) and future appointments
 * (openemr_postcalendar_events.pc_title / pc_hometext) draw from the same
 * curated template pool, so the same language appears across the chart.
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

final readonly class VisitReasonPicker
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
     * Pick a visit reason. 60% of the time prefer an archetype-relevant
     * reason (e.g. diabetes follow-up for a diabetic patient); otherwise
     * fall back to the weighted general pool.
     */
    public function pick(PatientArchetype $archetype): string
    {
        $relevant = $this->relevantReasonsFor($archetype);
        if ($relevant !== [] && $this->faker->numberBetween(1, 100) <= 60) {
            return $relevant[array_rand($relevant)];
        }
        return $this->weightedPick()['reason'];
    }

    /**
     * @return list<string>
     */
    private function relevantReasonsFor(PatientArchetype $archetype): array
    {
        return match ($archetype) {
            PatientArchetype::HealthyAdult => ['Annual wellness exam'],
            PatientArchetype::Hypertensive => [
                'Follow-up: hypertension',
                'Medication review',
                'Annual wellness exam',
            ],
            PatientArchetype::Diabetic, PatientArchetype::DiabeticUncontrolled => [
                'Follow-up: diabetes type 2',
                'Medication review',
                'Lab review — abnormal results',
            ],
            PatientArchetype::ComplexElderly => [
                'Follow-up: hypertension',
                'Follow-up: hyperlipidemia',
                'Medication review',
                'Annual wellness exam',
            ],
            PatientArchetype::RecentEdVisit => [
                'Lab review — abnormal results',
                'Medication review',
            ],
        };
    }

    /**
     * @return array{reason: string, pc_catid: int, weight: int}
     */
    private function weightedPick(): array
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
