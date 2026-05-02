<?php

/**
 * In-memory implementations of every adapter DataSource interface,
 * driven by an ArchetypeChart. Tests instantiate one set per archetype
 * and feed adapters from it.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderDataSource;

final readonly class InMemoryPatientDataSource implements PatientDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findByPid(int $pid): ?array
    {
        return $pid === $this->chart->pid ? $this->chart->patientRow : null;
    }
}

final readonly class InMemoryConditionDataSource implements ConditionDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findActiveForPid(int $pid): array
    {
        return $pid === $this->chart->pid ? $this->chart->conditionRows : [];
    }
}

final readonly class InMemoryPrescriptionDataSource implements PrescriptionDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        return $pid === $this->chart->pid ? $this->chart->prescriptionRows : [];
    }
}

final readonly class InMemoryAllergyDataSource implements AllergyDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findActiveForPid(int $pid): array
    {
        return $pid === $this->chart->pid ? $this->chart->allergyRows : [];
    }
}

final readonly class InMemoryEncounterDataSource implements EncounterDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        return $pid === $this->chart->pid ? $this->chart->encounterRows : [];
    }
}

final readonly class InMemoryExternalEncounterDataSource implements ExternalEncounterDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        return $pid === $this->chart->pid ? $this->chart->externalEncounterRows : [];
    }
}

final readonly class InMemoryObservationDataSource implements ObservationDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findRecentForPid(int $pid, int $lookbackDays): array
    {
        if ($pid !== $this->chart->pid) {
            return [];
        }
        // The factory emits rows with `observed_at` set; respect lookback so
        // tests get the same windowing semantics production will use.
        $cutoff = (new DateTimeImmutable(ArchetypeChartFactory::TODAY))
            ->modify('-' . $lookbackDays . ' days');
        $kept = [];
        foreach ($this->chart->observationRows as $row) {
            $observedAt = $row['observed_at'] ?? null;
            if (!is_string($observedAt)) {
                continue;
            }
            if (new DateTimeImmutable($observedAt) >= $cutoff) {
                $kept[] = $row;
            }
        }
        return $kept;
    }

    public function findHistoryByAnalyteForPid(
        int $pid,
        string $analyte,
        int $lookbackDays,
    ): array {
        if ($pid !== $this->chart->pid) {
            return [];
        }
        $cutoff = (new DateTimeImmutable(ArchetypeChartFactory::TODAY))
            ->modify('-' . $lookbackDays . ' days');
        $needle = strtolower($analyte);
        $kept = [];
        foreach ($this->chart->observationRows as $row) {
            $observedAt = $row['observed_at'] ?? null;
            if (!is_string($observedAt)) {
                continue;
            }
            if (new DateTimeImmutable($observedAt) < $cutoff) {
                continue;
            }
            $rowAnalyte = $row['analyte'] ?? null;
            if (!is_string($rowAnalyte)) {
                continue;
            }
            if (str_contains(strtolower($rowAnalyte), $needle)) {
                $kept[] = $row;
            }
        }
        return $kept;
    }
}

final readonly class InMemoryAppointmentDataSource implements AppointmentDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findOnDate(int $pid, string $practitionerUuid, DateTimeImmutable $date): ?array
    {
        if ($pid !== $this->chart->pid) {
            return null;
        }
        if ($this->chart->appointmentRow === null) {
            return null;
        }
        $appointmentDate = $this->chart->appointmentRow['pc_eventDate'] ?? null;
        if ($appointmentDate !== $date->format('Y-m-d')) {
            return null;
        }
        return $this->chart->appointmentRow;
    }
}

final readonly class InMemoryReminderDataSource implements ReminderDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findDueForPid(int $pid, int $cap): array
    {
        if ($pid !== $this->chart->pid) {
            return [];
        }
        $rows = $this->chart->reminderRows;
        return array_slice($rows, 0, $cap);
    }
}

final readonly class InMemoryMedicationStatementDataSource implements MedicationStatementDataSource
{
    public function __construct(private ArchetypeChart $chart)
    {
    }

    public function findActiveForPid(int $pid): array
    {
        return $pid === $this->chart->pid ? $this->chart->medicationStatementRows : [];
    }
}
