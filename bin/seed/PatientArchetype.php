<?php

/**
 * PatientArchetype defines coherent clinical profiles the seed pipeline draws
 * from. Each archetype declares its required problems and medications (so a
 * "diabetic" patient actually has metformin and an A1c-eligible problem),
 * encounter cadence, and demographic biases.
 *
 * The seed command picks an archetype per patient *first*, then drives every
 * downstream generator (problems, meds, encounters, vitals, allergies) off
 * the archetype. This is what makes the USERS.md briefing scenarios
 * reproducible: a diabetic patient is guaranteed to have the data shape that
 * UC1's "deltas since last visit" and UC2's lab-trend drill-downs require.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed;

enum PatientArchetype: string
{
    case HealthyAdult = 'healthy_adult';
    case Hypertensive = 'hypertensive';
    case Diabetic = 'diabetic';
    case DiabeticUncontrolled = 'diabetic_uncontrolled';
    case ComplexElderly = 'complex_elderly';
    case RecentEdVisit = 'recent_ed_visit';

    /**
     * Population-level mix used by the seed command. Values are relative
     * weights (do not need to sum to 100 — caller normalises).
     *
     * @return array<string, int>
     */
    public static function distribution(): array
    {
        return [
            self::HealthyAdult->value => 40,
            self::Hypertensive->value => 20,
            self::Diabetic->value => 15,
            self::DiabeticUncontrolled->value => 5,
            self::ComplexElderly->value => 15,
            self::RecentEdVisit->value => 5,
        ];
    }

    /**
     * Required ICD-10 problems for this archetype. The generator inserts
     * exactly these (one lists row each) and may layer 0-2 additional
     * weighted picks on top.
     *
     * @return list<array{code: string, title: string}>
     */
    public function requiredProblems(): array
    {
        return match ($this) {
            self::HealthyAdult => [],
            self::Hypertensive => [
                ['code' => 'I10', 'title' => 'Essential (primary) hypertension'],
            ],
            self::Diabetic, self::DiabeticUncontrolled => [
                ['code' => 'E11.9', 'title' => 'Type 2 diabetes mellitus without complications'],
            ],
            self::ComplexElderly => [
                ['code' => 'I10', 'title' => 'Essential (primary) hypertension'],
                ['code' => 'E78.5', 'title' => 'Hyperlipidemia, unspecified'],
                ['code' => 'M19.90', 'title' => 'Osteoarthritis, unspecified site'],
            ],
            self::RecentEdVisit => [],
        };
    }

    /**
     * Required medications (looked up by rxcui in common-meds.json).
     *
     * @return list<string>
     */
    public function requiredMedicationRxcuis(): array
    {
        return match ($this) {
            self::HealthyAdult => [],
            self::Hypertensive => ['314076'],          // Lisinopril 10 mg
            self::Diabetic => ['860975'],              // Metformin 500 mg
            self::DiabeticUncontrolled => ['860975', '314076'], // Metformin + lisinopril
            self::ComplexElderly => ['314076', '104375'], // Lisinopril + atorvastatin
            self::RecentEdVisit => [],
        };
    }

    /**
     * How many *additional* random problems on top of the required ones.
     */
    public function extraProblemRange(): array
    {
        return match ($this) {
            self::HealthyAdult => [0, 1],
            self::Hypertensive => [0, 2],
            self::Diabetic, self::DiabeticUncontrolled => [0, 2],
            self::ComplexElderly => [1, 3],
            self::RecentEdVisit => [0, 2],
        };
    }

    /**
     * How many *additional* random meds on top of the required ones.
     */
    public function extraMedicationRange(): array
    {
        return match ($this) {
            self::HealthyAdult => [0, 1],
            self::Hypertensive => [0, 2],
            self::Diabetic => [0, 2],
            self::DiabeticUncontrolled => [1, 3],
            self::ComplexElderly => [2, 4],
            self::RecentEdVisit => [0, 2],
        };
    }

    /**
     * Past-encounter count distributions (min/max).
     */
    public function encounterCountRange(): array
    {
        return match ($this) {
            self::HealthyAdult => [1, 2],
            self::Hypertensive, self::Diabetic => [2, 4],
            self::DiabeticUncontrolled => [3, 5],
            self::ComplexElderly => [3, 6],
            self::RecentEdVisit => [1, 3],
        };
    }

    /**
     * Age sampling bounds (years). Complex-elderly skews older.
     */
    public function ageRange(): array
    {
        return match ($this) {
            self::HealthyAdult => [22, 65],
            self::Hypertensive => [40, 80],
            self::Diabetic, self::DiabeticUncontrolled => [40, 78],
            self::ComplexElderly => [68, 88],
            self::RecentEdVisit => [30, 80],
        };
    }

    /**
     * Vital baselines used by VitalsGenerator. Returns systolic centre,
     * diastolic centre, BMI centre. The generator jitters each.
     *
     * @return array{bps: int, bpd: int, bmi: float}
     */
    public function vitalsBaseline(): array
    {
        return match ($this) {
            self::HealthyAdult => ['bps' => 120, 'bpd' => 78, 'bmi' => 24.5],
            self::Hypertensive => ['bps' => 142, 'bpd' => 88, 'bmi' => 29.0],
            self::Diabetic => ['bps' => 132, 'bpd' => 82, 'bmi' => 31.5],
            self::DiabeticUncontrolled => ['bps' => 138, 'bpd' => 86, 'bmi' => 33.0],
            self::ComplexElderly => ['bps' => 140, 'bpd' => 78, 'bmi' => 28.0],
            self::RecentEdVisit => ['bps' => 128, 'bpd' => 80, 'bmi' => 27.0],
        };
    }
}
