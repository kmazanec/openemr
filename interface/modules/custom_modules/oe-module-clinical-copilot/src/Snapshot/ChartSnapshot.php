<?php

/**
 * Aggregate ChartSnapshot — the model-facing data contract.
 *
 * Mirrors ARCHITECTURE.md §"ChartSnapshot". Phase 2.2 adapters build
 * the sub-DTOs; Phase 2.3 PhiMinimizer drops categories the request
 * envelope didn't ask for; Phase 2.4 emits AGENT_PHI_DISCLOSURE before
 * this leaves OpenEMR. The agent-side decoder (Phase 3.1) consumes the
 * `toArray()` JSON shape.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use TypeError;

/**
 * @phpstan-import-type DemographicsArray from Demographics
 * @phpstan-import-type AppointmentArray from Appointment
 * @phpstan-import-type DiagnosisArray from Diagnosis
 * @phpstan-import-type MedicationArray from Medication
 * @phpstan-import-type AllergyArray from Allergy
 * @phpstan-import-type LabObservationArray from LabObservation
 * @phpstan-import-type EncounterArray from Encounter
 *
 * @phpstan-type ChartSnapshotArray array{
 *     patient: DemographicsArray,
 *     appointment: ?AppointmentArray,
 *     diagnoses: list<DiagnosisArray>,
 *     medications: list<MedicationArray>,
 *     allergies: list<AllergyArray>,
 *     labs: list<LabObservationArray>,
 *     encounters: list<EncounterArray>,
 * }
 */
final readonly class ChartSnapshot
{
    /** @var list<Diagnosis> */
    public array $diagnoses;

    /** @var list<Medication> */
    public array $medications;

    /** @var list<Allergy> */
    public array $allergies;

    /** @var list<LabObservation> */
    public array $labs;

    /** @var list<Encounter> */
    public array $encounters;

    /**
     * @param list<Diagnosis> $diagnoses
     * @param list<Medication> $medications
     * @param list<Allergy> $allergies
     * @param list<LabObservation> $labs
     * @param list<Encounter> $encounters
     */
    public function __construct(
        public Demographics $patient,
        public ?Appointment $appointment,
        array $diagnoses,
        array $medications,
        array $allergies,
        array $labs,
        array $encounters,
    ) {
        self::assertItemTypes($diagnoses, Diagnosis::class, 'diagnoses');
        self::assertItemTypes($medications, Medication::class, 'medications');
        self::assertItemTypes($allergies, Allergy::class, 'allergies');
        self::assertItemTypes($labs, LabObservation::class, 'labs');
        self::assertItemTypes($encounters, Encounter::class, 'encounters');

        $this->diagnoses = $diagnoses;
        $this->medications = $medications;
        $this->allergies = $allergies;
        $this->labs = $labs;
        $this->encounters = $encounters;
    }

    /**
     * @return ChartSnapshotArray
     */
    public function toArray(): array
    {
        return [
            'patient' => $this->patient->toArray(),
            'appointment' => $this->appointment?->toArray(),
            'diagnoses' => array_map(fn (Diagnosis $d): array => $d->toArray(), $this->diagnoses),
            'medications' => array_map(fn (Medication $m): array => $m->toArray(), $this->medications),
            'allergies' => array_map(fn (Allergy $a): array => $a->toArray(), $this->allergies),
            'labs' => array_map(fn (LabObservation $l): array => $l->toArray(), $this->labs),
            'encounters' => array_map(fn (Encounter $e): array => $e->toArray(), $this->encounters),
        ];
    }

    /**
     * @param array<mixed> $items
     * @param class-string $expected
     */
    private static function assertItemTypes(array $items, string $expected, string $field): void
    {
        foreach ($items as $idx => $item) {
            if (! $item instanceof $expected) {
                $given = get_debug_type($item);
                throw new TypeError(
                    "ChartSnapshot.{$field}[{$idx}] must be {$expected}, {$given} given",
                );
            }
        }
    }
}
