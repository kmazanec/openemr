<?php

/**
 * AppointmentGenerator builds payloads for AppointmentService::insert().
 *
 * Reasons are picked via VisitReasonPicker so future appointments use the
 * same language as historical encounters for the same archetype. Status is
 * caller-controlled — the schedule command sets '-' for upcoming visits and
 * picks from a small status pool for past ones.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed\Generators;

use OpenEMR\Seed\PatientArchetype;

final readonly class AppointmentGenerator
{
    /** Standard slot length in seconds (15 minutes — matches OpenEMR default appointment length). */
    private const SLOT_DURATION_SECONDS = 900;

    public function __construct(private VisitReasonPicker $reasonPicker)
    {
    }

    /**
     * Build an appointment payload suitable for AppointmentService::insert($pid, $data).
     *
     * @return array<string, string|int>
     */
    public function generate(
        PatientArchetype $archetype,
        int $providerId,
        string $date,
        string $startTime,
        string $apptStatus,
    ): array {
        $reason = $this->reasonPicker->pick($archetype);
        return [
            'pc_catid'            => 9, // Established Patient
            'pc_title'            => $reason,
            'pc_duration'         => self::SLOT_DURATION_SECONDS,
            'pc_hometext'         => $reason,
            'pc_apptstatus'       => $apptStatus,
            'pc_eventDate'        => $date,
            'pc_startTime'        => $startTime,
            'pc_facility'         => 3,
            'pc_billing_location' => 3,
            'pc_aid'              => $providerId,
        ];
    }
}
