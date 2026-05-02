<?php

/**
 * Convenience: drive every adapter against an ArchetypeChart and
 * assemble a ChartSnapshot. Mirrors what the Phase 2.5 debug snapshot
 * route is going to do once it's wired — single point of truth for
 * how the snapshot is composed from adapters.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ChartSnapshot;

final readonly class SnapshotBuilder
{
    /** Lookback applied to encounters and labs in the test snapshot. */
    public const LOOKBACK_DAYS = 1095;

    public static function build(ArchetypeChart $chart): ChartSnapshot
    {
        $today = new DateTimeImmutable(ArchetypeChartFactory::TODAY);

        $patient = (new PatientAdapter(new InMemoryPatientDataSource($chart)))
            ->fetch($chart->pid);
        $diagnoses = (new ConditionAdapter(new InMemoryConditionDataSource($chart)))
            ->fetchActive($chart->pid);
        $prescriptions = (new PrescriptionAdapter(new InMemoryPrescriptionDataSource($chart)))
            ->fetchRecent($chart->pid, self::LOOKBACK_DAYS);
        $allergies = (new AllergyAdapter(new InMemoryAllergyDataSource($chart)))
            ->fetchActive($chart->pid);
        $encounters = (new EncounterAdapter(new InMemoryEncounterDataSource($chart)))
            ->fetchRecent($chart->pid, self::LOOKBACK_DAYS);
        $labs = (new ObservationAdapter(new InMemoryObservationDataSource($chart)))
            ->fetchRecent($chart->pid, self::LOOKBACK_DAYS);
        $appointment = (new AppointmentAdapter(new InMemoryAppointmentDataSource($chart)))
            ->fetchToday($chart->pid, ArchetypeChartFactory::PRACTITIONER_UUID, $today);
        $reminders = (new ReminderAdapter(new InMemoryReminderDataSource($chart)))
            ->fetchDue($chart->pid);

        return new ChartSnapshot(
            patient: $patient,
            appointment: $appointment,
            diagnoses: $diagnoses,
            prescriptions: $prescriptions,
            allergies: $allergies,
            labs: $labs,
            encounters: $encounters,
            reminders: $reminders,
        );
    }
}
