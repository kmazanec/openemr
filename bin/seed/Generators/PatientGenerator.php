<?php

/**
 * PatientGenerator builds patient_data field arrays via PHP Faker.
 *
 * Produces only data — does not insert. The caller (SeedPatientsCommand)
 * passes each generated array to PatientService::insert() so OpenEMR's
 * normal validation, UUID minting, and event-dispatch happen exactly as
 * they do in the application.
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

final readonly class PatientGenerator
{
    private const SEX_DISTRIBUTION = ['Male' => 49, 'Female' => 49, 'Unspecified' => 2];

    /** Demo race codes used by upstream OpenEMR (see patient_data.race column). */
    private const RACE_DISTRIBUTION = [
        'white' => 60,
        'black_or_afri_amer' => 13,
        'asian' => 6,
        'amer_ind_or_alaska_native' => 2,
        'native_haw_or_pac_island' => 1,
        '' => 18,
    ];

    private const ETHNICITY_DISTRIBUTION = [
        'not_hisp_or_latin' => 70,
        'hisp_or_latin' => 18,
        '' => 12,
    ];

    private const STATUS_DISTRIBUTION = [
        'married' => 45,
        'single' => 38,
        'divorced' => 8,
        'widowed' => 5,
        '' => 4,
    ];

    public function __construct(private Faker $faker)
    {
    }

    /**
     * Build one patient_data field array suitable for PatientService::insert().
     *
     * @return array<string, string|int>
     */
    public function generate(PatientArchetype $archetype, int $pcpUserId): array
    {
        $sex = $this->weightedPick(self::SEX_DISTRIBUTION);
        $fname = match ($sex) {
            'Male' => $this->faker->firstNameMale(),
            'Female' => $this->faker->firstNameFemale(),
            default => $this->faker->firstName(),
        };

        [$minAge, $maxAge] = $archetype->ageRange();
        $dob = $this->faker
            ->dateTimeBetween('-' . $maxAge . ' years', '-' . $minAge . ' years')
            ->format('Y-m-d');

        return [
            'fname'     => $fname,
            'lname'     => $this->faker->lastName(),
            'mname'     => $this->faker->boolean(15) ? $this->faker->firstName() : '',
            'sex'       => $sex,
            'DOB'       => $dob,
            'street'    => $this->faker->streetAddress(),
            'city'      => $this->faker->city(),
            'state'     => $this->faker->stateAbbr(),
            'postal_code' => $this->faker->postcode(),
            'country_code' => 'US',
            'phone_home'  => $this->faker->phoneNumber(),
            'phone_cell'  => $this->faker->phoneNumber(),
            'email'     => $this->faker->boolean(70) ? $this->faker->safeEmail() : '',
            'language'  => 'English',
            'race'      => $this->weightedPick(self::RACE_DISTRIBUTION),
            'ethnicity' => $this->weightedPick(self::ETHNICITY_DISTRIBUTION),
            'status'    => $this->weightedPick(self::STATUS_DISTRIBUTION),
            'occupation'  => $this->faker->boolean(60) ? $this->faker->jobTitle() : '',
            'providerID'  => $pcpUserId,
        ];
    }

    /**
     * Pick a key from {value => weight} proportional to weight.
     *
     * @param array<string, int> $distribution
     */
    private function weightedPick(array $distribution): string
    {
        $total = array_sum($distribution);
        $roll = $this->faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach ($distribution as $value => $weight) {
            $cumulative += $weight;
            if ($roll <= $cumulative) {
                return (string) $value;
            }
        }
        return (string) array_key_first($distribution);
    }
}
