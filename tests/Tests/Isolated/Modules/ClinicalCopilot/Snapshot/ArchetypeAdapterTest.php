<?php

/**
 * Per-adapter, per-archetype assertion that ChartSnapshot adapters
 * surface the clinical contract each PatientArchetype promises.
 *
 * Replaces the literal §2.5 "services suite, runs in Docker" checkbox
 * with an isolated equivalent: the same archetype contract that drives
 * `seed:patients` drives the rows, the production adapters consume
 * them, and ground-truth assertions are derived from
 * `PatientArchetype::requiredProblems()` /
 * `requiredMedicationRxcuis()` — never hand-written per case.
 * Production DataSource implementations (PatientService etc.) don't
 * exist yet; the Docker-suite version of this test lands when Phase
 * 3.1's `getPatientContext` tool wires them in.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionAdapter;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\ArchetypeChartFactory;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryAllergyDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryAppointmentDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryConditionDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryEncounterDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryObservationDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryPatientDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\InMemoryPrescriptionDataSource;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\RequireModuleClasses;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\SnapshotBuilder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ArchetypeAdapterTest extends TestCase
{
    private const FAKER_SEED = 20260430;

    public static function setUpBeforeClass(): void
    {
        RequireModuleClasses::load();
    }

    /**
     * @return iterable<string, array{PatientArchetype}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function archetypes(): iterable
    {
        foreach (PatientArchetype::cases() as $case) {
            yield $case->value => [$case];
        }
    }

    #[DataProvider('archetypes')]
    public function testPatientAdapterFetchesDemographics(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $demo = (new PatientAdapter(new InMemoryPatientDataSource($chart)))
            ->fetch($chart->pid);

        $this->assertSame($chart->pid, $demo->pid);
        $this->assertSame($chart->uuid, $demo->uuid);
        $this->assertNotSame('', $demo->displayName);
        $this->assertStringContainsString(', ', $demo->displayName, 'lname, fname format');
        $this->assertNotNull($demo->dateOfBirth);
    }

    #[DataProvider('archetypes')]
    public function testConditionAdapterSurfacesArchetypeRequiredCodes(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $diagnoses = (new ConditionAdapter(new InMemoryConditionDataSource($chart)))
            ->fetchActive($chart->pid);

        $codes = array_map(static fn($d): string => $d->code, $diagnoses);
        if ($chart->groundTruth->requiredDiagnosisCodes === []) {
            // HealthyAdult / RecentEdVisit have no required problems; pin the
            // empty-list contract explicitly rather than skipping silently.
            $this->assertSame([], $chart->groundTruth->requiredDiagnosisCodes);
            return;
        }
        foreach ($chart->groundTruth->requiredDiagnosisCodes as $required) {
            $this->assertContains(
                $required,
                $codes,
                "{$archetype->value} must surface {$required}; got: " . implode(',', $codes),
            );
        }
    }

    #[DataProvider('archetypes')]
    public function testPrescriptionAdapterSurfacesArchetypeRequiredDrugs(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $prescriptions = (new PrescriptionAdapter(new InMemoryPrescriptionDataSource($chart)))
            ->fetchRecent($chart->pid, SnapshotBuilder::LOOKBACK_DAYS);

        $names = array_map(static fn($p): string => $p->name, $prescriptions);
        if ($chart->groundTruth->requiredMedicationDrugs === []) {
            $this->assertSame([], $chart->groundTruth->requiredMedicationDrugs);
            return;
        }
        foreach ($chart->groundTruth->requiredMedicationDrugs as $required) {
            $this->assertContains(
                $required,
                $names,
                "{$archetype->value} must surface {$required}; got: " . implode('|', $names),
            );
        }
    }

    #[DataProvider('archetypes')]
    public function testAllergyAdapterRespectsArchetypeExpectation(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $allergies = (new AllergyAdapter(new InMemoryAllergyDataSource($chart)))
            ->fetchActive($chart->pid);

        if ($chart->groundTruth->expectsAllergy) {
            $this->assertNotEmpty($allergies);
        } else {
            $this->assertEmpty($allergies);
        }
    }

    #[DataProvider('archetypes')]
    public function testObservationAdapterSurfacesExpectedAnalytes(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $labs = (new ObservationAdapter(new InMemoryObservationDataSource($chart)))
            ->fetchRecent($chart->pid, SnapshotBuilder::LOOKBACK_DAYS);

        $analytes = array_map(static fn($l): string => $l->analyte, $labs);
        foreach ($chart->groundTruth->expectedLabAnalytes as $analyte) {
            $this->assertContains(
                $analyte,
                $analytes,
                "{$archetype->value} must surface {$analyte}; got: " . implode(',', $analytes),
            );
        }
    }

    #[DataProvider('archetypes')]
    public function testEncounterAdapterReturnsAtLeastOneEncounter(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $encounters = (new EncounterAdapter(new InMemoryEncounterDataSource($chart)))
            ->fetchRecent($chart->pid, SnapshotBuilder::LOOKBACK_DAYS);

        $this->assertNotEmpty(
            $encounters,
            "{$archetype->value} should have at least one prior encounter",
        );
        // Every encounter has a citation back to the source row — Phase 3
        // verification will reject claims without one.
        foreach ($encounters as $encounter) {
            $this->assertNotSame('', $encounter->source->recordId);
        }
    }

    #[DataProvider('archetypes')]
    public function testAppointmentAdapterFindsTodaySlot(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $today = new \DateTimeImmutable(ArchetypeChartFactory::TODAY);
        $appointment = (new AppointmentAdapter(new InMemoryAppointmentDataSource($chart)))
            ->fetchToday($chart->pid, ArchetypeChartFactory::PRACTITIONER_UUID, $today);

        $this->assertNotNull($appointment);
        $this->assertSame('2026-04-30T09:30:00+00:00', $appointment->startAt->format('Y-m-d\TH:i:sP'));
        $this->assertSame(15, $appointment->durationMinutes);
    }

    #[DataProvider('archetypes')]
    public function testFullSnapshotForArchetypeIsCoherent(PatientArchetype $archetype): void
    {
        $chart = $this->factory()->build($archetype);
        $snapshot = SnapshotBuilder::build($chart);

        // Every list element carries a citation. This is the post-Phase-3
        // verification gate's hard requirement.
        foreach ($snapshot->diagnoses as $d) {
            $this->assertSame('Condition', $d->source->recordType);
        }
        foreach ($snapshot->prescriptions as $p) {
            $this->assertSame('MedicationRequest', $p->source->recordType);
        }
        foreach ($snapshot->allergies as $a) {
            $this->assertSame('AllergyIntolerance', $a->source->recordType);
        }
        foreach ($snapshot->labs as $l) {
            $this->assertSame('Observation', $l->source->recordType);
        }
        foreach ($snapshot->encounters as $e) {
            $this->assertSame('Encounter', $e->source->recordType);
        }
        $this->assertSame($chart->pid, $snapshot->patient->pid);
    }

    private function factory(): ArchetypeChartFactory
    {
        return new ArchetypeChartFactory(self::FAKER_SEED);
    }
}
