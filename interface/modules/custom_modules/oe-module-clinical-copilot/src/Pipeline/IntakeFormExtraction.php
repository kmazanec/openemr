<?php

/**
 * Intake-form extraction DTO. PHP mirror of the Zod schema in
 * `agent/src/pipeline/schemas/intakeForm.ts`. Field names + required/
 * optional shape match exactly.
 *
 * The five categories — demographics, allergies, current medications,
 * past medical history, family history — are the slots the W2
 * demographics-delta detection (Q2b) compares against the chart in the
 * `emitDeltas` node.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Pipeline;

use DomainException;

/**
 * @phpstan-import-type CitedFieldArray from CitedField
 *
 * @phpstan-type IntakeAllergyArray array{
 *     substance: string,
 *     reaction?: ?string,
 *     severity?: ?string,
 *     page: int,
 *     bbox: array{float|int, float|int, float|int, float|int},
 *     quote: string,
 *     confidence: float
 * }
 *
 * @phpstan-type IntakeMedicationArray array{
 *     name: string,
 *     dose?: ?string,
 *     frequency?: ?string,
 *     route?: ?string,
 *     notes?: ?string,
 *     page: int,
 *     bbox: array{float|int, float|int, float|int, float|int},
 *     quote: string,
 *     confidence: float
 * }
 *
 * @phpstan-type PastMedicalHistoryArray array{
 *     condition: string,
 *     onset_year?: ?string,
 *     notes?: ?string,
 *     page: int,
 *     bbox: array{float|int, float|int, float|int, float|int},
 *     quote: string,
 *     confidence: float
 * }
 *
 * @phpstan-type FamilyHistoryArray array{
 *     relation: string,
 *     condition: string,
 *     notes?: ?string,
 *     page: int,
 *     bbox: array{float|int, float|int, float|int, float|int},
 *     quote: string,
 *     confidence: float
 * }
 *
 * @phpstan-type IntakeDemographicsArray array{
 *     name: CitedFieldArray,
 *     dob: CitedFieldArray,
 *     sex: CitedFieldArray,
 *     address?: CitedFieldArray,
 *     phone?: CitedFieldArray,
 *     email?: CitedFieldArray
 * }
 *
 * @phpstan-type IntakeFormExtractionArray array{
 *     patient_demographics: IntakeDemographicsArray,
 *     allergies: list<IntakeAllergyArray>,
 *     current_medications: list<IntakeMedicationArray>,
 *     past_medical_history: list<PastMedicalHistoryArray>,
 *     family_history: list<FamilyHistoryArray>
 * }
 */
final readonly class IntakeFormExtraction
{
    private const ALLOWED_SEX = ['male', 'female', 'other', 'unknown'];

    /**
     * @param list<IntakeAllergy> $allergies
     * @param list<IntakeMedication> $currentMedications
     * @param list<PastMedicalHistoryEntry> $pastMedicalHistory
     * @param list<FamilyHistoryEntry> $familyHistory
     */
    public function __construct(
        public CitedField $name,
        public CitedField $dob,
        public CitedField $sex,
        public ?CitedField $address,
        public ?CitedField $phone,
        public ?CitedField $email,
        public array $allergies,
        public array $currentMedications,
        public array $pastMedicalHistory,
        public array $familyHistory,
    ) {
        if (!in_array($this->sex->value, self::ALLOWED_SEX, true)) {
            throw new DomainException('IntakeFormExtraction.patient_demographics.sex.value must be one of male|female|other|unknown');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $demographics = ExtractionFieldDecoder::requireObject($data, 'patient_demographics', 'IntakeFormExtraction');
        $name = ExtractionFieldDecoder::requireObject($demographics, 'name', 'IntakeFormExtraction.patient_demographics');
        $dob = ExtractionFieldDecoder::requireObject($demographics, 'dob', 'IntakeFormExtraction.patient_demographics');
        $sex = ExtractionFieldDecoder::requireObject($demographics, 'sex', 'IntakeFormExtraction.patient_demographics');
        $address = self::optionalCitedField($demographics, 'address');
        $phone = self::optionalCitedField($demographics, 'phone');
        $email = self::optionalCitedField($demographics, 'email');

        return new self(
            name: CitedField::fromArray($name),
            dob: CitedField::fromArray($dob),
            sex: CitedField::fromArray($sex),
            address: $address,
            phone: $phone,
            email: $email,
            allergies: self::decodeList($data, 'allergies', IntakeAllergy::fromArray(...)),
            currentMedications: self::decodeList($data, 'current_medications', IntakeMedication::fromArray(...)),
            pastMedicalHistory: self::decodeList($data, 'past_medical_history', PastMedicalHistoryEntry::fromArray(...)),
            familyHistory: self::decodeList($data, 'family_history', FamilyHistoryEntry::fromArray(...)),
        );
    }

    /**
     * @param array<string, mixed> $demographics
     */
    private static function optionalCitedField(array $demographics, string $key): ?CitedField
    {
        if (!array_key_exists($key, $demographics)) {
            return null;
        }
        $raw = $demographics[$key];
        if ($raw === null) {
            return null;
        }
        if (!is_array($raw)) {
            throw new DomainException("IntakeFormExtraction.patient_demographics.{$key} must be an object");
        }
        /** @var array<string, mixed> $raw */
        return CitedField::fromArray($raw);
    }

    /**
     * @template T
     * @param array<string, mixed> $data
     * @param callable(array<string, mixed>): T $factory
     * @return list<T>
     */
    private static function decodeList(array $data, string $key, callable $factory): array
    {
        $raw = $data[$key] ?? null;
        if (!is_array($raw)) {
            throw new DomainException("IntakeFormExtraction.{$key} must be an array");
        }
        $out = [];
        foreach ($raw as $row) {
            if (!is_array($row)) {
                throw new DomainException("IntakeFormExtraction.{$key} entries must be objects");
            }
            /** @var array<string, mixed> $row */
            $out[] = $factory($row);
        }
        return $out;
    }

    /**
     * @return IntakeFormExtractionArray
     */
    public function toArray(): array
    {
        $demographics = [
            'name' => $this->name->toArray(),
            'dob' => $this->dob->toArray(),
            'sex' => $this->sex->toArray(),
        ];
        if ($this->address !== null) {
            $demographics['address'] = $this->address->toArray();
        }
        if ($this->phone !== null) {
            $demographics['phone'] = $this->phone->toArray();
        }
        if ($this->email !== null) {
            $demographics['email'] = $this->email->toArray();
        }
        /** @var IntakeDemographicsArray $demographics */
        /** @var list<IntakeAllergyArray> $allergies */
        $allergies = array_map(static fn(IntakeAllergy $a): array => $a->toArray(), $this->allergies);
        /** @var list<IntakeMedicationArray> $meds */
        $meds = array_map(static fn(IntakeMedication $m): array => $m->toArray(), $this->currentMedications);
        /** @var list<PastMedicalHistoryArray> $pmh */
        $pmh = array_map(static fn(PastMedicalHistoryEntry $e): array => $e->toArray(), $this->pastMedicalHistory);
        /** @var list<FamilyHistoryArray> $fh */
        $fh = array_map(static fn(FamilyHistoryEntry $e): array => $e->toArray(), $this->familyHistory);
        return [
            'patient_demographics' => $demographics,
            'allergies' => $allergies,
            'current_medications' => $meds,
            'past_medical_history' => $pmh,
            'family_history' => $fh,
        ];
    }
}
