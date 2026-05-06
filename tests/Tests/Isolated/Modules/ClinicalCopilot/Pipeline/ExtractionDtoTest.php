<?php

/**
 * Isolated tests for the lab-PDF and intake-form extraction DTOs.
 *
 * Pins the JSON shape the agent's vision node persists to Tier 2 — and
 * which the OpenEMR-side code decodes for chart-side promotion. The
 * round-trip (`fromArray` → `toArray`) preserves every field; required
 * fields raise `DomainException`; unknown keys are dropped silently
 * just as Zod's `.passthrough()` does on the agent side.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Pipeline;

use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\CitedField;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\ExtractionFieldDecoder;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\FamilyHistoryEntry;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\IntakeAllergy;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\IntakeFormExtraction;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\IntakeMedication;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\LabPdfExtraction;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\LabResult;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\OrderingProvider;
use OpenEMR\Modules\ClinicalCopilot\Pipeline\PastMedicalHistoryEntry;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

final class ExtractionDtoTest extends TestCase
{
    private const MODULE_PIPELINE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Pipeline';

    public static function setUpBeforeClass(): void
    {
        $files = [
            'CitedField.php',
            'ExtractionFieldDecoder.php',
            'OrderingProvider.php',
            'LabResult.php',
            'LabPdfExtraction.php',
            'IntakeAllergy.php',
            'IntakeMedication.php',
            'PastMedicalHistoryEntry.php',
            'FamilyHistoryEntry.php',
            'IntakeFormExtraction.php',
        ];
        foreach ($files as $f) {
            require_once self::MODULE_PIPELINE_DIR . '/' . $f;
        }
    }

    /**
     * @return iterable<string, array{class-string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function dtoClasses(): iterable
    {
        yield 'CitedField' => [CitedField::class];
        yield 'OrderingProvider' => [OrderingProvider::class];
        yield 'LabResult' => [LabResult::class];
        yield 'LabPdfExtraction' => [LabPdfExtraction::class];
        yield 'IntakeAllergy' => [IntakeAllergy::class];
        yield 'IntakeMedication' => [IntakeMedication::class];
        yield 'PastMedicalHistoryEntry' => [PastMedicalHistoryEntry::class];
        yield 'FamilyHistoryEntry' => [FamilyHistoryEntry::class];
        yield 'IntakeFormExtraction' => [IntakeFormExtraction::class];
    }

    /**
     * @param class-string $class
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('dtoClasses')]
    public function testDtoIsFinalAndReadonly(string $class): void
    {
        $rc = new ReflectionClass($class);
        $this->assertTrue($rc->isFinal(), "{$class} must be final");
        $this->assertTrue($rc->isReadOnly(), "{$class} must be a readonly class");
    }

    public function testCitedFieldRoundTrip(): void
    {
        $arr = [
            'value' => 'Jane Doe',
            'page' => 1,
            'bbox' => [10, 10, 100, 20],
            'quote' => 'Jane Doe',
            'confidence' => 0.95,
        ];
        $decoded = CitedField::fromArray($arr);
        $this->assertSame('Jane Doe', $decoded->value);
        $this->assertSame(1, $decoded->page);
        $this->assertSame($arr, $decoded->toArray());
    }

    public function testCitedFieldRejectsNegativePage(): void
    {
        $this->expectException(DomainException::class);
        new CitedField(value: 'x', page: 0, bbox: [0, 0, 1, 1], quote: 'x', confidence: 0.5);
    }

    public function testCitedFieldRejectsBboxWrongLength(): void
    {
        $this->expectException(DomainException::class);
        CitedField::fromArray([
            'value' => 'x',
            'page' => 1,
            'bbox' => [0, 0, 1],
            'quote' => 'x',
            'confidence' => 0.5,
        ]);
    }

    public function testCitedFieldRejectsConfidenceOutOfRange(): void
    {
        $this->expectException(DomainException::class);
        CitedField::fromArray([
            'value' => 'x',
            'page' => 1,
            'bbox' => [0, 0, 1, 1],
            'quote' => 'x',
            'confidence' => 1.7,
        ]);
    }

    public function testLabPdfExtractionRoundTrip(): void
    {
        $arr = $this->validLabPdfArray();
        $decoded = LabPdfExtraction::fromArray($arr);
        $this->assertSame('Jane Doe', $decoded->name->value);
        $this->assertCount(1, $decoded->results);
        $this->assertSame('HbA1c', $decoded->results[0]->analyteName);
        $this->assertSame('1234567890', $decoded->orderingProvider->npi);
        // Key order isn't part of the JSON contract (json_decode produces
        // associative arrays whose iteration order callers can't depend
        // on); compare canonically.
        $this->assertEqualsCanonicalizing($arr, $decoded->toArray());
    }

    public function testLabPdfExtractionDropsUnknownKeys(): void
    {
        $arr = $this->validLabPdfArray();
        /** @var array<string, mixed> $demographics */
        $demographics = $arr['patient_demographics'];
        $demographics['height_cm'] = 170;
        $arr['patient_demographics'] = $demographics;
        $arr['specimen_collection_method'] = 'venipuncture';

        $decoded = LabPdfExtraction::fromArray($arr);
        $reSerialized = $decoded->toArray();

        // Unknown top-level + nested keys do not survive the round-trip.
        $this->assertArrayNotHasKey('specimen_collection_method', $reSerialized);
        $this->assertArrayNotHasKey('height_cm', $reSerialized['patient_demographics']);
    }

    public function testLabPdfExtractionRejectsEmptyResults(): void
    {
        $arr = $this->validLabPdfArray();
        $arr['results'] = [];

        $this->expectException(DomainException::class);
        LabPdfExtraction::fromArray($arr);
    }

    public function testLabPdfExtractionRejectsInvalidSex(): void
    {
        $arr = $this->validLabPdfArray();
        /** @var array<string, mixed> $demographics */
        $demographics = $arr['patient_demographics'];
        /** @var array<string, mixed> $sex */
        $sex = $demographics['sex'];
        $sex['value'] = 'unspecified';
        $demographics['sex'] = $sex;
        $arr['patient_demographics'] = $demographics;

        $this->expectException(DomainException::class);
        LabPdfExtraction::fromArray($arr);
    }

    public function testLabResultAcceptsMinimalRequiredFields(): void
    {
        $arr = [
            'analyte_name' => 'Hgb',
            'value' => '14.0',
            'unit' => 'g/dL',
            'collection_date' => '2026-04-15',
            'page' => 2,
            'bbox' => [50, 220, 200, 20],
            'quote' => 'Hgb 14.0 g/dL',
            'confidence' => 0.9,
        ];
        $decoded = LabResult::fromArray($arr);
        $this->assertNull($decoded->panelCode);
        $this->assertNull($decoded->refRangeLow);
        $this->assertNull($decoded->refRangeHigh);
        $this->assertNull($decoded->abnormalFlag);
        $this->assertEqualsCanonicalizing($arr, $decoded->toArray());
    }

    public function testLabResultRejectsInvalidAbnormalFlag(): void
    {
        $arr = [
            'analyte_name' => 'Hgb',
            'value' => '14.0',
            'unit' => 'g/dL',
            'abnormal_flag' => 'wonky',
            'collection_date' => '2026-04-15',
            'page' => 2,
            'bbox' => [50, 220, 200, 20],
            'quote' => 'Hgb',
            'confidence' => 0.9,
        ];
        $this->expectException(DomainException::class);
        LabResult::fromArray($arr);
    }

    public function testIntakeFormExtractionRoundTrip(): void
    {
        $arr = $this->validIntakeFormArray();
        $decoded = IntakeFormExtraction::fromArray($arr);
        $this->assertSame('John Roe', $decoded->name->value);
        $this->assertSame('male', $decoded->sex->value);
        $this->assertSame('Penicillin', $decoded->allergies[0]->substance);
        $this->assertSame('Metformin', $decoded->currentMedications[0]->name);
        $this->assertSame('Type 2 Diabetes', $decoded->pastMedicalHistory[0]->condition);
        $this->assertSame('mother', $decoded->familyHistory[0]->relation);
        $this->assertEqualsCanonicalizing($arr, $decoded->toArray());
    }

    public function testIntakeFormExtractionAcceptsEmptyLists(): void
    {
        $arr = $this->validIntakeFormArray();
        $arr['allergies'] = [];
        $arr['current_medications'] = [];
        $arr['past_medical_history'] = [];
        $arr['family_history'] = [];

        $decoded = IntakeFormExtraction::fromArray($arr);
        $this->assertSame([], $decoded->allergies);
        $this->assertSame([], $decoded->currentMedications);
        $this->assertSame([], $decoded->pastMedicalHistory);
        $this->assertSame([], $decoded->familyHistory);
    }

    public function testIntakeFormExtractionDropsUnknownKeys(): void
    {
        $arr = $this->validIntakeFormArray();
        /** @var list<array<string, mixed>> $allergies */
        $allergies = $arr['allergies'];
        $allergies[0]['source_form_label'] = 'Q4';
        $arr['allergies'] = $allergies;
        $arr['insurance_carrier'] = 'Acme Health';

        $decoded = IntakeFormExtraction::fromArray($arr);
        $reSerialized = $decoded->toArray();
        $this->assertArrayNotHasKey('insurance_carrier', $reSerialized);
        $this->assertArrayNotHasKey('source_form_label', $reSerialized['allergies'][0]);
    }

    public function testIntakeFormExtractionAcceptsOptionalContactDemographics(): void
    {
        $arr = $this->validIntakeFormArray();
        /** @var array<string, mixed> $demographics */
        $demographics = $arr['patient_demographics'];
        $demographics['address'] = [
            'value' => '123 Main St',
            'page' => 1,
            'bbox' => [10, 70, 200, 20],
            'quote' => '123 Main St',
            'confidence' => 0.9,
        ];
        $demographics['phone'] = [
            'value' => '555-0100',
            'page' => 1,
            'bbox' => [10, 90, 200, 20],
            'quote' => '555-0100',
            'confidence' => 0.9,
        ];
        $arr['patient_demographics'] = $demographics;

        $decoded = IntakeFormExtraction::fromArray($arr);
        $this->assertNotNull($decoded->address);
        $this->assertSame('123 Main St', $decoded->address->value);
        $this->assertNotNull($decoded->phone);
        $this->assertNull($decoded->email);
    }

    public function testIntakeFormExtractionRejectsMissingDemographics(): void
    {
        $arr = $this->validIntakeFormArray();
        unset($arr['patient_demographics']);
        $this->expectException(DomainException::class);
        IntakeFormExtraction::fromArray($arr);
    }

    public function testExtractionFieldDecoderOptionalStringTreatsNullAsAbsent(): void
    {
        $this->assertNull(
            ExtractionFieldDecoder::optionalString(['x' => null], 'x', 'Test'),
        );
        $this->assertNull(
            ExtractionFieldDecoder::optionalString([], 'x', 'Test'),
        );
        $this->assertSame(
            'present',
            ExtractionFieldDecoder::optionalString(['x' => 'present'], 'x', 'Test'),
        );
    }

    public function testExtractionFieldDecoderRejectsNonNumericConfidence(): void
    {
        $this->expectException(DomainException::class);
        ExtractionFieldDecoder::requireConfidence(['confidence' => 'high'], 'Test');
    }

    /**
     * @return array<string, mixed>
     */
    private function validLabPdfArray(): array
    {
        return [
            'patient_demographics' => [
                'name' => $this->citedFieldArray('Jane Doe', 1, [10, 10, 100, 20], 'Jane Doe', 0.95),
                'dob' => $this->citedFieldArray('1980-05-12', 1, [10, 30, 100, 20], '05/12/1980', 0.9),
                'sex' => $this->citedFieldArray('female', 1, [10, 50, 100, 20], 'F', 0.85),
            ],
            'results' => [
                [
                    'panel_code' => 'CMP',
                    'analyte_name' => 'HbA1c',
                    'value' => '7.2',
                    'unit' => '%',
                    'ref_range_low' => '4.0',
                    'ref_range_high' => '5.6',
                    'abnormal_flag' => 'high',
                    'collection_date' => '2026-04-15',
                    'page' => 2,
                    'bbox' => [50, 200, 200, 30],
                    'quote' => 'HbA1c 7.2 %',
                    'confidence' => 0.92,
                ],
            ],
            'ordering_provider' => [
                'name' => 'Dr. Alice Smith',
                'npi' => '1234567890',
                'page' => 1,
                'bbox' => [400, 700, 200, 20],
                'quote' => 'Ordering: Dr. Alice Smith NPI 1234567890',
                'confidence' => 0.88,
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function validIntakeFormArray(): array
    {
        return [
            'patient_demographics' => [
                'name' => $this->citedFieldArray('John Roe', 1, [10, 10, 100, 20], 'John Roe', 0.9),
                'dob' => $this->citedFieldArray('1970-01-01', 1, [10, 30, 100, 20], '01/01/1970', 0.9),
                'sex' => $this->citedFieldArray('male', 1, [10, 50, 100, 20], 'M', 0.9),
            ],
            'allergies' => [
                [
                    'substance' => 'Penicillin',
                    'reaction' => 'Hives',
                    'severity' => 'moderate',
                    'page' => 2,
                    'bbox' => [10, 100, 200, 20],
                    'quote' => 'Penicillin — hives',
                    'confidence' => 0.9,
                ],
            ],
            'current_medications' => [
                [
                    'name' => 'Metformin',
                    'dose' => '500 mg',
                    'frequency' => 'BID',
                    'page' => 2,
                    'bbox' => [10, 200, 200, 20],
                    'quote' => 'Metformin 500mg BID',
                    'confidence' => 0.9,
                ],
            ],
            'past_medical_history' => [
                [
                    'condition' => 'Type 2 Diabetes',
                    'onset_year' => '2018',
                    'page' => 3,
                    'bbox' => [10, 100, 200, 20],
                    'quote' => 'T2DM dx 2018',
                    'confidence' => 0.85,
                ],
            ],
            'family_history' => [
                [
                    'relation' => 'mother',
                    'condition' => 'Coronary artery disease',
                    'page' => 3,
                    'bbox' => [10, 200, 200, 20],
                    'quote' => 'Mother: CAD',
                    'confidence' => 0.85,
                ],
            ],
        ];
    }

    /**
     * @param array{int|float, int|float, int|float, int|float} $bbox
     * @return array<string, mixed>
     */
    private function citedFieldArray(string $value, int $page, array $bbox, string $quote, float $confidence): array
    {
        return [
            'value' => $value,
            'page' => $page,
            'bbox' => $bbox,
            'quote' => $quote,
            'confidence' => $confidence,
        ];
    }
}
