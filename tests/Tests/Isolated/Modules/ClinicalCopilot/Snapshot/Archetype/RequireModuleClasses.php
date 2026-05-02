<?php

/**
 * Loads every Snapshot/RequestLog/factory class an end-to-end test
 * needs. The isolated test suite doesn't run module PSR-4 autoload at
 * the same paths the runtime does, so each test that touches the
 * module classes has historically maintained its own require list.
 * This helper consolidates that list.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype;

final class RequireModuleClasses
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src';

    private const FACTORY_DIR = __DIR__;

    public static function load(): void
    {
        $module = self::MODULE_DIR;
        $files = [
            $module . '/Snapshot/SourceReference.php',
            $module . '/Snapshot/Demographics.php',
            $module . '/Snapshot/Diagnosis.php',
            $module . '/Snapshot/Prescription.php',
            $module . '/Snapshot/Allergy.php',
            $module . '/Snapshot/Encounter.php',
            $module . '/Snapshot/LabObservation.php',
            $module . '/Snapshot/Appointment.php',
            $module . '/Snapshot/Reminder.php',
            $module . '/Snapshot/ChartSnapshot.php',
            $module . '/Snapshot/DataCategory.php',
            $module . '/Snapshot/DataCategorySet.php',
            $module . '/Snapshot/PhiMinimizer.php',
            $module . '/Snapshot/Normalize.php',
            $module . '/Snapshot/Adapter/PatientDataSource.php',
            $module . '/Snapshot/Adapter/PatientAdapter.php',
            $module . '/Snapshot/Adapter/ConditionDataSource.php',
            $module . '/Snapshot/Adapter/ConditionAdapter.php',
            $module . '/Snapshot/Adapter/PrescriptionDataSource.php',
            $module . '/Snapshot/Adapter/PrescriptionAdapter.php',
            $module . '/Snapshot/PrescriptionProvenance.php',
            $module . '/Snapshot/Adapter/PrescriptionProvenanceDataSource.php',
            $module . '/Snapshot/Adapter/PrescriptionProvenanceAdapter.php',
            $module . '/Snapshot/Adapter/ReminderDataSource.php',
            $module . '/Snapshot/Adapter/ReminderAdapter.php',
            $module . '/Snapshot/MedicationStatement.php',
            $module . '/Snapshot/Adapter/MedicationStatementDataSource.php',
            $module . '/Snapshot/Adapter/MedicationStatementAdapter.php',
            $module . '/Snapshot/Adapter/AllergyDataSource.php',
            $module . '/Snapshot/Adapter/AllergyAdapter.php',
            $module . '/Snapshot/Adapter/EncounterDataSource.php',
            $module . '/Snapshot/Adapter/EncounterAdapter.php',
            $module . '/Snapshot/Adapter/ExternalEncounterDataSource.php',
            $module . '/Snapshot/Adapter/ExternalEncounterAdapter.php',
            $module . '/Snapshot/Adapter/ObservationDataSource.php',
            $module . '/Snapshot/Adapter/ObservationAdapter.php',
            $module . '/Snapshot/Adapter/AppointmentDataSource.php',
            $module . '/Snapshot/Adapter/AppointmentAdapter.php',
            $module . '/RequestLog/AgentDisclosure.php',
            $module . '/RequestLog/AgentDisclosedEvent.php',
            $module . '/RequestLog/DisclosureRecorder.php',
            $module . '/RequestLog/AgentRequestLogRecorder.php',
            $module . '/RequestLog/InMemoryDisclosureRecorder.php',
            $module . '/RequestLog/InMemoryAgentRequestLogRecorder.php',
            $module . '/RequestLog/AgentDisclosureListener.php',
            self::FACTORY_DIR . '/ArchetypeGroundTruth.php',
            self::FACTORY_DIR . '/ArchetypeChart.php',
            self::FACTORY_DIR . '/ArchetypeChartFactory.php',
            self::FACTORY_DIR . '/InMemoryDataSources.php',
            self::FACTORY_DIR . '/SnapshotBuilder.php',
        ];
        foreach ($files as $file) {
            require_once $file;
        }
    }
}
