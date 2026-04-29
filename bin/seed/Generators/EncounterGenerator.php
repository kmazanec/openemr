<?php

/**
 * EncounterGenerator builds form_encounter field arrays.
 *
 * Encounters are dated within the last ~3 years, biased toward more recent
 * dates so timelines look realistic without all visits clustering on one
 * day. Reasons come from VisitReasonPicker (archetype-biased).
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

final readonly class EncounterGenerator
{
    public function __construct(
        private Faker $faker,
        private VisitReasonPicker $reasonPicker,
    ) {
    }

    /**
     * @return array<string, string|int>
     */
    public function generate(int $providerId, PatientArchetype $archetype): array
    {
        return [
            'date'        => $this->faker->dateTimeBetween('-3 years', '-1 day')->format('Y-m-d H:i:s'),
            'reason'      => $this->reasonPicker->pick($archetype),
            'pc_catid'    => 1,
            'class_code'  => 'AMB',
            'provider_id' => $providerId,
            'facility_id' => 3,
            'sensitivity' => 'normal',
            'user'        => '',
            'group'       => '',
        ];
    }
}
