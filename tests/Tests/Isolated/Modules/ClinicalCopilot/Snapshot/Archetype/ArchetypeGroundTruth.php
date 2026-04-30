<?php

/**
 * Archetype-derived ground-truth assertions.
 *
 * Whatever survives normalization through every adapter must still
 * carry the contract the archetype promises: a Diabetic patient must
 * surface E11.9 + metformin, a Hypertensive must surface I10 +
 * lisinopril, etc. PRESEARCH decision #4 makes this the source of
 * eval truth — golden tests assert these facts, not hand-written
 * per-case expectations.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype;

use OpenEMR\Seed\PatientArchetype;

final readonly class ArchetypeGroundTruth
{
    /**
     * @param list<string> $requiredDiagnosisCodes
     * @param list<string> $requiredMedicationDrugs
     * @param list<string> $expectedLabAnalytes
     */
    private function __construct(
        public PatientArchetype $archetype,
        public array $requiredDiagnosisCodes,
        public array $requiredMedicationDrugs,
        public array $expectedLabAnalytes,
        public bool $expectsAllergy,
    ) {
    }

    public static function forArchetype(PatientArchetype $archetype): self
    {
        // Drug names mirror common-meds.json's `name` column for the rxcuis
        // declared in PatientArchetype::requiredMedicationRxcuis(). Hardcoded
        // here as the assertion contract — if the catalog drug name drifts
        // from these strings, the test catches it.
        // Drug names mirror common-meds.json's `name` column verbatim — the
        // adapter preserves the catalog string. Test fails if the catalog
        // drifts.
        $drugByRxcui = [
            '314076' => 'Lisinopril 10 MG Oral Tablet',
            '860975' => 'Metformin hydrochloride 500 MG Oral Tablet',
            '104375' => 'Atorvastatin 20 MG Oral Tablet',
        ];
        $drugs = array_map(
            static fn(string $rxcui): string => $drugByRxcui[$rxcui]
                ?? throw new \LogicException("ground-truth drug missing for rxcui {$rxcui}"),
            $archetype->requiredMedicationRxcuis(),
        );

        $codes = array_map(
            static fn(array $p): string => $p['code'],
            $archetype->requiredProblems(),
        );

        return new self(
            archetype: $archetype,
            requiredDiagnosisCodes: $codes,
            requiredMedicationDrugs: $drugs,
            expectedLabAnalytes: self::analytesFor($archetype),
            expectsAllergy: $archetype !== PatientArchetype::HealthyAdult,
        );
    }

    /**
     * @return list<string>
     */
    private static function analytesFor(PatientArchetype $archetype): array
    {
        // Mirrors the panels LabResultGenerator::generateForArchetype emits.
        // Each archetype always produces at least one analyte we can pin.
        // Mirror lab-templates.json's panel→test names exactly.
        return match ($archetype) {
            PatientArchetype::HealthyAdult => ['Glucose, Fasting'],
            PatientArchetype::Hypertensive => ['Cholesterol, Total'],
            PatientArchetype::Diabetic, PatientArchetype::DiabeticUncontrolled
                => ['Hemoglobin A1c'],
            PatientArchetype::ComplexElderly => ['Cholesterol, Total'],
            PatientArchetype::RecentEdVisit => ['Glucose, Fasting'],
        };
    }
}
