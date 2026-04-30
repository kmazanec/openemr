<?php

/**
 * ExternalEncounterGenerator builds external_encounters rows representing
 * outside-facility care that has been imported into OpenEMR (typically via
 * CCDA). UC4's "any care at other facilities recently?" briefing slot
 * reads from this table.
 *
 * For RecentEdVisit archetype: 1 ED visit + 1 follow-up consult in the
 * last 60 days. For other archetypes: ~10% chance of an opportunistic
 * recent ED visit.
 *
 * The seed command does the actual SQL INSERT — there is no write-side
 * service for this table in OpenEMR.
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

final readonly class ExternalEncounterGenerator
{
    /**
     * Realistic ED-visit shapes — chief complaint, the diagnosis they came
     * out with, and the facility name we'll embed.
     *
     * @var list<array{diagnosis: string, facility: string}>
     */
    private const ED_VISITS = [
        ['diagnosis' => 'Chest pain, ruled out acute MI', 'facility' => 'Regional Memorial ED'],
        ['diagnosis' => 'Acute abdominal pain, resolved', 'facility' => 'Saint Mary Hospital ED'],
        ['diagnosis' => 'Hypertensive urgency', 'facility' => 'Mercy Health ED'],
        ['diagnosis' => 'Acute bronchitis', 'facility' => 'Regional Memorial ED'],
        ['diagnosis' => 'Syncope, evaluation', 'facility' => 'Saint Mary Hospital ED'],
        ['diagnosis' => 'Migraine with aura', 'facility' => 'Mercy Health ED'],
    ];

    /**
     * Specialty consults that typically follow an ED visit.
     *
     * @var list<array{diagnosis: string, facility: string}>
     */
    private const CONSULTS = [
        ['diagnosis' => 'Cardiology consult — atypical chest pain', 'facility' => 'Riverside Cardiology Associates'],
        ['diagnosis' => 'Neurology consult — migraine', 'facility' => 'Riverside Neurology Group'],
        ['diagnosis' => 'GI consult — abdominal pain workup', 'facility' => 'Riverside Gastroenterology'],
        ['diagnosis' => 'Pulmonology consult — recurrent bronchitis', 'facility' => 'Riverside Pulmonary'],
    ];

    public function __construct(private Faker $faker)
    {
    }

    /**
     * @return list<array{ee_date: string, ee_facility_id: string, ee_encounter_diagnosis: string, ee_external_id: string}>
     */
    public function generate(int $pid, PatientArchetype $archetype): array
    {
        if ($archetype === PatientArchetype::RecentEdVisit) {
            $edDays = $this->faker->numberBetween(20, 50);
            $consultDays = $this->faker->numberBetween(7, $edDays - 1);
            $ed = self::ED_VISITS[array_rand(self::ED_VISITS)];
            $consult = self::CONSULTS[array_rand(self::CONSULTS)];
            return [
                $this->buildRow($pid, $edDays, $ed),
                $this->buildRow($pid, $consultDays, $consult),
            ];
        }
        // Opportunistic ED visit for ~10% of other patients.
        if ($this->faker->numberBetween(1, 100) <= 10) {
            $ed = self::ED_VISITS[array_rand(self::ED_VISITS)];
            return [$this->buildRow($pid, $this->faker->numberBetween(20, 60), $ed)];
        }
        return [];
    }

    /**
     * @param array{diagnosis: string, facility: string} $template
     * @return array{ee_date: string, ee_facility_id: string, ee_encounter_diagnosis: string, ee_external_id: string}
     */
    private function buildRow(int $pid, int $daysAgo, array $template): array
    {
        $date = (new \DateTimeImmutable("-{$daysAgo} days"))->format('Y-m-d');
        return [
            'ee_date'                 => $date,
            'ee_facility_id'          => $template['facility'],
            'ee_encounter_diagnosis'  => $template['diagnosis'],
            'ee_external_id'          => 'EXT-' . substr(bin2hex(random_bytes(4)), 0, 8),
        ];
    }
}
