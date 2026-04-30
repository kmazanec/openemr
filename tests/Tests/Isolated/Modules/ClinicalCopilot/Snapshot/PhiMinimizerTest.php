<?php

/**
 * Isolated tests for PhiMinimizer.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Allergy;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Appointment;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\ChartSnapshot;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategory;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategorySet;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Demographics;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Diagnosis;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Encounter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\LabObservation;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Medication;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\PhiMinimizer;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use PHPUnit\Framework\TestCase;

final class PhiMinimizerTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        $files = [
            'SourceReference.php',
            'Demographics.php',
            'Appointment.php',
            'Diagnosis.php',
            'Medication.php',
            'Allergy.php',
            'LabObservation.php',
            'Encounter.php',
            'ChartSnapshot.php',
            'DataCategory.php',
            'DataCategorySet.php',
            'PhiMinimizer.php',
        ];
        foreach ($files as $f) {
            require_once self::MODULE_SNAPSHOT_DIR . '/' . $f;
        }
    }

    public function testStripsCategoriesNotInRequest(): void
    {
        $snapshot = $this->fullSnapshot();
        $minimizer = new PhiMinimizer();

        $minimized = $minimizer->withCategories(
            $snapshot,
            DataCategorySet::of(DataCategory::Diagnosis, DataCategory::Allergy),
        );

        $this->assertCount(1, $minimized->diagnoses);
        $this->assertCount(1, $minimized->allergies);
        $this->assertSame([], $minimized->medications);
        $this->assertSame([], $minimized->labs);
        $this->assertSame([], $minimized->encounters);
        $this->assertNull($minimized->appointment);
    }

    public function testPatientIdentityIsAlwaysCarried(): void
    {
        // The pid/uuid is the trust anchor — every request scopes to one
        // patient, and the disclosure-audit row keys on it. The minimizer
        // can never strip Demographics, even with an empty category set.
        $snapshot = $this->fullSnapshot();
        $minimizer = new PhiMinimizer();

        $minimized = $minimizer->withCategories($snapshot, DataCategorySet::empty());

        $this->assertSame($snapshot->patient, $minimized->patient);
    }

    public function testEmptyCategorySetClearsAllClinicalSlices(): void
    {
        $snapshot = $this->fullSnapshot();
        $minimized = (new PhiMinimizer())->withCategories($snapshot, DataCategorySet::empty());

        $this->assertSame([], $minimized->diagnoses);
        $this->assertSame([], $minimized->medications);
        $this->assertSame([], $minimized->allergies);
        $this->assertSame([], $minimized->labs);
        $this->assertSame([], $minimized->encounters);
        $this->assertNull($minimized->appointment);
    }

    public function testFullCategorySetIsIdempotent(): void
    {
        $snapshot = $this->fullSnapshot();
        $minimized = (new PhiMinimizer())->withCategories($snapshot, DataCategorySet::all());

        // Same data — but it's a new ChartSnapshot instance (the minimizer
        // never mutates) so we compare via toArray().
        $this->assertSame($snapshot->toArray(), $minimized->toArray());
        $this->assertNotSame($snapshot, $minimized);
    }

    public function testAppointmentDroppedWhenAppointmentCategoryAbsent(): void
    {
        $snapshot = $this->fullSnapshot();
        $minimized = (new PhiMinimizer())->withCategories(
            $snapshot,
            DataCategorySet::of(DataCategory::Diagnosis),
        );
        $this->assertNull($minimized->appointment);
    }

    public function testAppointmentRetainedWhenAppointmentCategoryPresent(): void
    {
        $snapshot = $this->fullSnapshot();
        $minimized = (new PhiMinimizer())->withCategories(
            $snapshot,
            DataCategorySet::of(DataCategory::Appointment),
        );
        $this->assertNotNull($minimized->appointment);
        $this->assertSame('apt-9', $minimized->appointment->appointmentId);
    }

    public function testDemographicsCarriesNoExcludedFields(): void
    {
        // ARCHITECTURE.md §"ChartSnapshot > Excluded by default":
        //   SSN, driver's license, full street address, phone, email,
        //   non-unique MRN/pubpid (except as display text), billing data,
        //   family/contact fields, full historical chart outside window.
        // None of those names may appear as a key in Demographics::toArray().
        $patient = $this->fullSnapshot()->patient;
        $serialized = json_encode($patient->toArray(), JSON_THROW_ON_ERROR);

        foreach (PhiMinimizer::EXCLUDED_FROM_DEMOGRAPHICS as $forbidden) {
            $this->assertStringNotContainsString(
                "\"{$forbidden}\"",
                $serialized,
                "Demographics must never carry the excluded field: {$forbidden}",
            );
        }
    }

    public function testExcludedListCoversArchitectureBullets(): void
    {
        // ARCHITECTURE.md §"Excluded by default" enumerates SSN,
        // driver's license, street address, phone, email, MRN/pubpid,
        // billing-only data, family/contact fields. The list pinned in
        // PhiMinimizer must cover each of those categories — the test
        // names them by the OpenEMR column shape a future contributor
        // is most likely to reach for.
        $required = [
            'ssn',           // SSN
            'drivers_license', // driver's license
            'street',        // full street address
            'phone_home',    // phone (home)
            'phone_cell',    // phone (cell)
            'phone_biz',     // phone (biz)
            'email',         // email
            'pubpid',        // non-unique MRN / pubpid
            'billing',       // billing-only data
            'mothersname',   // family/contact fields
            'next_of_kin',
            'guardian',
        ];
        foreach ($required as $field) {
            $this->assertContains(
                $field,
                PhiMinimizer::EXCLUDED_FROM_DEMOGRAPHICS,
                "EXCLUDED_FROM_DEMOGRAPHICS must include '{$field}' (architecture bullet)",
            );
        }
    }

    public function testExcludedListNeverOverlapsCarriedDemographicsKeys(): void
    {
        // Sanity: the exclusion list must not name any field that the
        // Demographics DTO actually carries — that would be contradictory.
        $carriedKeys = ['pid', 'uuid', 'displayName', 'sex', 'dateOfBirth', 'source'];
        $overlap = array_intersect($carriedKeys, PhiMinimizer::EXCLUDED_FROM_DEMOGRAPHICS);
        $this->assertSame(
            [],
            array_values($overlap),
            'EXCLUDED_FROM_DEMOGRAPHICS must not name fields the Demographics DTO carries',
        );
    }

    private function fullSnapshot(): ChartSnapshot
    {
        $ref = fn (string $type, string $id): SourceReference => new SourceReference(
            system: 'openemr',
            recordType: $type,
            recordId: $id,
        );
        return new ChartSnapshot(
            patient: new Demographics(
                pid: 101,
                uuid: '550e8400-e29b-41d4-a716-446655440000',
                displayName: 'Patel, Maya',
                sex: 'F',
                dateOfBirth: new DateTimeImmutable('1968-02-14'),
                source: $ref('Patient', '101'),
            ),
            appointment: new Appointment(
                appointmentId: 'apt-9',
                startAt: new DateTimeImmutable('2026-05-01T09:30:00+00:00'),
                durationMinutes: 30,
                type: 'office-visit',
                reason: 'diabetes follow-up',
                source: $ref('Appointment', 'apt-9'),
            ),
            diagnoses: [
                new Diagnosis(
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes',
                    onsetDate: new DateTimeImmutable('2024-08-01'),
                    source: $ref('Condition', 'cond-1'),
                ),
            ],
            medications: [
                new Medication(
                    name: 'metformin',
                    dose: '500 mg',
                    route: 'oral',
                    frequency: 'BID',
                    startDate: new DateTimeImmutable('2024-08-15'),
                    stopDate: null,
                    prescriber: 'Patel, Maya',
                    source: $ref('MedicationRequest', 'rx-77'),
                ),
            ],
            allergies: [
                new Allergy(
                    substance: 'penicillin',
                    reaction: 'hives',
                    severity: 'moderate',
                    source: $ref('AllergyIntolerance', 'allergy-3'),
                ),
            ],
            labs: [
                new LabObservation(
                    analyte: 'A1c',
                    value: '8.4',
                    unit: '%',
                    referenceRange: '4.0-5.6',
                    abnormalFlag: 'H',
                    observedAt: new DateTimeImmutable('2026-04-15'),
                    source: $ref('Observation', 'obs-12'),
                ),
            ],
            encounters: [
                new Encounter(
                    encounterDate: new DateTimeImmutable('2026-03-10'),
                    type: 'office-visit',
                    reason: 'follow-up',
                    source: $ref('Encounter', 'enc-44'),
                ),
            ],
        );
    }
}
