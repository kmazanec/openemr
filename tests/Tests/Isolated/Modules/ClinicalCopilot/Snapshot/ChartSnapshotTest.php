<?php

/**
 * Isolated tests for ChartSnapshot DTO and its sub-DTOs.
 *
 * Pins the JSON shape every adapter (Phase 2.2) must produce and every
 * agent-side decoder (Phase 3.1) must consume. The shape mirrors
 * ARCHITECTURE.md §"ChartSnapshot" + §"Source Reference".
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Demographics;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Diagnosis;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Encounter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\LabObservation;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\MedicationStatement;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Prescription;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Reminder;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

final class ChartSnapshotTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        // Module classes aren't on the autoloader's runtime path during
        // isolated tests. Mirrors PolicyGateTest's pattern.
        $files = [
            'SourceReference.php',
            'Demographics.php',
            'Appointment.php',
            'Diagnosis.php',
            'Prescription.php',
            'Allergy.php',
            'LabObservation.php',
            'Encounter.php',
            'Reminder.php',
            'MedicationStatement.php',
            'ChartSnapshot.php',
        ];
        foreach ($files as $f) {
            require_once self::MODULE_SNAPSHOT_DIR . '/' . $f;
        }
    }

    /**
     * @return iterable<string, array{class-string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function dtoClasses(): iterable
    {
        yield 'SourceReference' => [SourceReference::class];
        yield 'Demographics' => [Demographics::class];
        yield 'Appointment' => [Appointment::class];
        yield 'Diagnosis' => [Diagnosis::class];
        yield 'Prescription' => [Prescription::class];
        yield 'Allergy' => [Allergy::class];
        yield 'LabObservation' => [LabObservation::class];
        yield 'Encounter' => [Encounter::class];
        yield 'Reminder' => [Reminder::class];
        yield 'MedicationStatement' => [MedicationStatement::class];
        yield 'ChartSnapshot' => [ChartSnapshot::class];
    }

    /**
     * Every DTO must be `final readonly`. This is enforced structurally so
     * a future contributor can't accidentally introduce a mutable subclass
     * or a non-readonly property.
     *
     * @param class-string $class
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('dtoClasses')]
    public function testDtoIsFinalAndReadonly(string $class): void
    {
        $rc = new ReflectionClass($class);
        $this->assertTrue($rc->isFinal(), "{$class} must be final");
        $this->assertTrue($rc->isReadOnly(), "{$class} must be a readonly class");
    }

    /**
     * @param class-string $class
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('dtoClasses')]
    public function testDtoExposesToArray(string $class): void
    {
        $rc = new ReflectionClass($class);
        $this->assertTrue($rc->hasMethod('toArray'), "{$class} must expose toArray()");
        $method = $rc->getMethod('toArray');
        $returnType = $method->getReturnType();
        $this->assertNotNull($returnType, "{$class}::toArray() must declare a return type");
        $this->assertSame('array', (string) $returnType, "{$class}::toArray() must return array");
    }

    public function testDiagnosisToArrayShape(): void
    {
        $diag = new Diagnosis(
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes mellitus without complications',
            onsetDate: new DateTimeImmutable('2024-08-01'),
            source: $this->ref('condition.code', 'cond-1'),
        );

        $this->assertSame(
            [
                'code' => 'E11.9',
                'codeSystem' => 'ICD-10',
                'label' => 'Type 2 diabetes mellitus without complications',
                'onsetDate' => '2024-08-01',
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'cond-1',
                    'locator' => ['field' => 'condition.code'],
                    'quote' => 'cond-1',
                ],
            ],
            $diag->toArray(),
        );
    }

    public function testPrescriptionToArrayShape(): void
    {
        $rx = new Prescription(
            name: 'metformin',
            dose: '500 mg',
            route: 'oral',
            frequency: 'BID',
            startDate: new DateTimeImmutable('2024-08-15'),
            stopDate: null,
            prescriber: 'Patel, Maya',
            indication: 'type 2 diabetes',
            prescriptionId: 77,
            source: $this->ref('medication.name', 'rx-77'),
        );

        $this->assertSame(
            [
                'name' => 'metformin',
                'dose' => '500 mg',
                'route' => 'oral',
                'frequency' => 'BID',
                'startDate' => '2024-08-15',
                'stopDate' => null,
                'prescriber' => 'Patel, Maya',
                'indication' => 'type 2 diabetes',
                'prescriptionId' => 77,
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'rx-77',
                    'locator' => ['field' => 'medication.name'],
                    'quote' => 'rx-77',
                ],
            ],
            $rx->toArray(),
        );
    }

    public function testAllergyToArrayShape(): void
    {
        $allergy = new Allergy(
            substance: 'penicillin',
            reaction: 'hives',
            severity: 'moderate',
            source: $this->ref('allergy.substance', 'allergy-3'),
        );

        $this->assertSame(
            [
                'substance' => 'penicillin',
                'reaction' => 'hives',
                'severity' => 'moderate',
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'allergy-3',
                    'locator' => ['field' => 'allergy.substance'],
                    'quote' => 'allergy-3',
                ],
            ],
            $allergy->toArray(),
        );
    }

    public function testLabObservationToArrayShape(): void
    {
        $lab = new LabObservation(
            analyte: 'A1c',
            value: '8.4',
            unit: '%',
            referenceRange: '4.0-5.6',
            abnormalFlag: 'H',
            observedAt: new DateTimeImmutable('2026-04-15'),
            source: $this->ref('valueQuantity', 'obs-12', recordedAt: new DateTimeImmutable('2026-04-15')),
        );

        $this->assertSame(
            [
                'analyte' => 'A1c',
                'value' => '8.4',
                'unit' => '%',
                'referenceRange' => '4.0-5.6',
                'abnormalFlag' => 'H',
                'observedAt' => '2026-04-15',
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'obs-12',
                    'locator' => ['field' => 'valueQuantity'],
                    'quote' => 'obs-12',
                    'meta' => ['record_recorded_at' => '2026-04-15'],
                ],
            ],
            $lab->toArray(),
        );
    }

    public function testEncounterToArrayShape(): void
    {
        $enc = new Encounter(
            encounterDate: new DateTimeImmutable('2026-03-10'),
            type: 'office-visit',
            reason: 'follow-up: diabetes',
            source: $this->ref('encounter.date', 'enc-44'),
        );

        $this->assertSame(
            [
                'encounterDate' => '2026-03-10',
                'type' => 'office-visit',
                'reason' => 'follow-up: diabetes',
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'enc-44',
                    'locator' => ['field' => 'encounter.date'],
                    'quote' => 'enc-44',
                ],
            ],
            $enc->toArray(),
        );
    }

    public function testReminderToArrayShape(): void
    {
        $reminder = new Reminder(
            item: 'mammogram',
            itemTitle: 'Mammogram screening',
            category: 'screening',
            categoryTitle: 'Screening',
            dueStatus: 'overdue',
            createdAt: new DateTimeImmutable('2025-11-01'),
            reminderId: 85001,
            source: $this->ref('task.description', 'rem-85001'),
        );

        $this->assertSame(
            [
                'item' => 'mammogram',
                'itemTitle' => 'Mammogram screening',
                'category' => 'screening',
                'categoryTitle' => 'Screening',
                'dueStatus' => 'overdue',
                'createdAt' => '2025-11-01',
                'reminderId' => 85001,
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'rem-85001',
                    'locator' => ['field' => 'task.description'],
                    'quote' => 'rem-85001',
                ],
            ],
            $reminder->toArray(),
        );
    }

    public function testMedicationStatementToArrayShape(): void
    {
        $stmt = new MedicationStatement(
            name: 'Tylenol',
            dose: '500 mg as needed',
            usageCategory: 'OTC',
            informationSource: 'Patient',
            startDate: new DateTimeImmutable('2024-06-01'),
            stopDate: null,
            listId: 95001,
            source: $this->ref('medicationStatement.medication', 'msmt-95001'),
        );

        $this->assertSame(
            [
                'name' => 'Tylenol',
                'dose' => '500 mg as needed',
                'usageCategory' => 'OTC',
                'informationSource' => 'Patient',
                'startDate' => '2024-06-01',
                'stopDate' => null,
                'listId' => 95001,
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'msmt-95001',
                    'locator' => ['field' => 'medicationStatement.medication'],
                    'quote' => 'msmt-95001',
                ],
            ],
            $stmt->toArray(),
        );
    }

    public function testAppointmentToArrayShape(): void
    {
        $appt = new Appointment(
            appointmentId: 'apt-9',
            startAt: new DateTimeImmutable('2026-05-01T09:30:00+00:00'),
            durationMinutes: 30,
            type: 'office-visit',
            reason: 'diabetes follow-up',
            source: $this->ref('appointment.start', 'apt-9'),
        );

        $this->assertSame(
            [
                'appointmentId' => 'apt-9',
                'startAt' => '2026-05-01T09:30:00+00:00',
                'durationMinutes' => 30,
                'type' => 'office-visit',
                'reason' => 'diabetes follow-up',
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => 'apt-9',
                    'locator' => ['field' => 'appointment.start'],
                    'quote' => 'apt-9',
                ],
            ],
            $appt->toArray(),
        );
    }

    public function testDemographicsToArrayShape(): void
    {
        $demo = new Demographics(
            pid: 101,
            uuid: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'Patel, Maya',
            sex: 'F',
            dateOfBirth: new DateTimeImmutable('1968-02-14'),
            ageYears: 58,
            source: $this->ref('patient.name', '101'),
        );

        $this->assertSame(
            [
                'pid' => 101,
                'uuid' => '550e8400-e29b-41d4-a716-446655440000',
                'displayName' => 'Patel, Maya',
                'sex' => 'F',
                'dateOfBirth' => '1968-02-14',
                'ageYears' => 58,
                'source' => [
                    'source_type' => 'chart',
                    'source_id' => '101',
                    'locator' => ['field' => 'patient.name'],
                    'quote' => '101',
                ],
            ],
            $demo->toArray(),
        );
    }

    public function testFullSnapshotShapeAndJsonRoundTrip(): void
    {
        $snapshot = new ChartSnapshot(
            patient: new Demographics(
                pid: 101,
                uuid: '550e8400-e29b-41d4-a716-446655440000',
                displayName: 'Patel, Maya',
                sex: 'F',
                dateOfBirth: new DateTimeImmutable('1968-02-14'),
                ageYears: 58,
                source: $this->ref('patient.name', '101'),
            ),
            appointment: new Appointment(
                appointmentId: 'apt-9',
                startAt: new DateTimeImmutable('2026-05-01T09:30:00+00:00'),
                durationMinutes: 30,
                type: 'office-visit',
                reason: 'diabetes follow-up',
                source: $this->ref('appointment.start', 'apt-9'),
            ),
            diagnoses: [
                new Diagnosis(
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes mellitus without complications',
                    onsetDate: new DateTimeImmutable('2024-08-01'),
                    source: $this->ref('condition.code', 'cond-1'),
                ),
            ],
            prescriptions: [
                new Prescription(
                    name: 'metformin',
                    dose: '500 mg',
                    route: 'oral',
                    frequency: 'BID',
                    startDate: new DateTimeImmutable('2024-08-15'),
                    stopDate: null,
                    prescriber: 'Patel, Maya',
                    indication: 'type 2 diabetes',
                    prescriptionId: 77,
                    source: $this->ref('medication.name', 'rx-77'),
                ),
            ],
            allergies: [],
            labs: [
                new LabObservation(
                    analyte: 'A1c',
                    value: '8.4',
                    unit: '%',
                    referenceRange: '4.0-5.6',
                    abnormalFlag: 'H',
                    observedAt: new DateTimeImmutable('2026-04-15'),
                    source: $this->ref('observation.value', 'obs-12'),
                ),
            ],
            encounters: [
                new Encounter(
                    encounterDate: new DateTimeImmutable('2026-03-10'),
                    type: 'office-visit',
                    reason: 'follow-up: diabetes',
                    source: $this->ref('encounter.date', 'enc-44'),
                ),
            ],
            reminders: [
                new Reminder(
                    item: 'a1c_recheck',
                    itemTitle: 'A1c follow-up',
                    category: 'lab_followup',
                    categoryTitle: 'Lab follow-up',
                    dueStatus: 'due',
                    createdAt: new DateTimeImmutable('2026-04-01'),
                    reminderId: 85002,
                    source: $this->ref('task.description', 'rem-85002'),
                ),
            ],
            medications: [
                new MedicationStatement(
                    name: 'Tylenol',
                    dose: '500 mg as needed',
                    usageCategory: 'OTC',
                    informationSource: 'Patient',
                    startDate: new DateTimeImmutable('2024-06-01'),
                    stopDate: null,
                    listId: 95001,
                    source: $this->ref('medicationStatement.medication', 'msmt-95001'),
                ),
            ],
        );

        $array = $snapshot->toArray();

        // Lists serialize as JSON arrays, not objects.
        $encoded = json_encode($array, JSON_THROW_ON_ERROR);
        $this->assertStringContainsString('"diagnoses":[{', $encoded);
        $this->assertStringContainsString('"allergies":[]', $encoded);
        $this->assertStringContainsString('"reminders":[{', $encoded);
        $this->assertStringContainsString('"medications":[{', $encoded);

        // Round-trips losslessly through json. This is the runtime pin on
        // the top-level key set: a future drift in toArray() shows up as
        // a diff here, even though the static shape is also pinned by
        // @phpstan-type ChartSnapshotArray.
        $decoded = json_decode($encoded, true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame($array, $decoded);
    }

    public function testSnapshotAcceptsMissingAppointment(): void
    {
        $snapshot = new ChartSnapshot(
            patient: new Demographics(
                pid: 101,
                uuid: '550e8400-e29b-41d4-a716-446655440000',
                displayName: 'Patel, Maya',
                sex: 'F',
                dateOfBirth: new DateTimeImmutable('1968-02-14'),
                ageYears: 58,
                source: $this->ref('patient.name', '101'),
            ),
            appointment: null,
            diagnoses: [],
            prescriptions: [],
            allergies: [],
            labs: [],
            encounters: [],
        );

        $this->assertNull($snapshot->toArray()['appointment']);
    }

    public function testSnapshotRejectsHeterogeneousDiagnosisList(): void
    {
        $this->expectException(\TypeError::class);
        // PHP's native typed parameter enforces this — the test pins that
        // we are using a typed array param, not a bare `array`.
        new ChartSnapshot(
            patient: new Demographics(
                pid: 101,
                uuid: '550e8400-e29b-41d4-a716-446655440000',
                displayName: 'Patel, Maya',
                sex: 'F',
                dateOfBirth: new DateTimeImmutable('1968-02-14'),
                ageYears: 58,
                source: $this->ref('patient.name', '101'),
            ),
            appointment: null,
            // @phpstan-ignore argument.type
            diagnoses: ['not a Diagnosis'],
            prescriptions: [],
            allergies: [],
            labs: [],
            encounters: [],
        );
    }

    private function ref(
        string $field,
        string $sourceId,
        ?string $quote = null,
        ?DateTimeImmutable $recordedAt = null,
    ): SourceReference {
        return new SourceReference(
            sourceType: 'chart',
            sourceId: $sourceId,
            locator: ['field' => $field],
            quote: $quote ?? $sourceId,
            meta: $recordedAt !== null ? ['record_recorded_at' => $recordedAt->format('Y-m-d')] : null,
        );
    }
}
