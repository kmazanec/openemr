<?php

/**
 * FixturePatient pins the four demo patients whose intake forms and lab
 * results live under `docs/example-documents/`. They are seeded *before*
 * the random Faker fill so the agent's §B.6 patientMatch node can refuse
 * a wrong-patient document fixture deterministically — every fixture in
 * `docs/example-documents/` maps to one of these patients by lname + DOB.
 *
 * Adding a fixture document?
 *   1. Drop it under `docs/example-documents/<intake-forms|lab-results>/`.
 *   2. Make sure its name + DOB + sex match exactly one case below.
 *   3. Update the matching entry in
 *      `agent/evals/fixtures/document-extraction/source/manifest.json` so
 *      the §B.10 eval suite picks it up.
 *
 * Source-of-truth values (extracted directly from the fixture PDFs/PNGs):
 *
 *   p01  Chen, Margaret L.   1967-08-14  Female   diabetic + hyperlipidemia
 *   p02  Whitaker, James E.  1958-11-03  Male     complex elderly (AFib)
 *   p03  Reyes, Sofia M.     1983-12-19  Female   diabetic uncontrolled
 *   p04  Kowalski, Robert    1971-06-08  Male     recent ED visit (RUQ pain)
 *
 * The Reyes intake/lab fixtures are intentionally photograph-quality
 * (low-res, perspective-skewed, partially smudged) so the §B.10
 * adversarial / degraded eval cases can exercise the OCR-grade-bad
 * branch. The DOB encoded above (1983-12-19) matches what those
 * fixtures literally show — both the lab (`1983-12-19 (42F)`) and the
 * intake (`12/19/1983 (42)`). An earlier revision of this enum
 * encoded `1982-10-15`, which made the patient-match node refuse
 * every Reyes upload as a confident DOB mismatch. If a clearer
 * rescan ever lands, keep all three (seed enum, lab, intake) in sync.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed;

enum FixturePatient: string
{
    case Chen = 'p01-chen';
    case Whitaker = 'p02-whitaker';
    case Reyes = 'p03-reyes';
    case Kowalski = 'p04-kowalski';

    public function firstName(): string
    {
        return match ($this) {
            self::Chen => 'Margaret',
            self::Whitaker => 'James',
            self::Reyes => 'Sofia',
            self::Kowalski => 'Robert',
        };
    }

    public function middleName(): string
    {
        return match ($this) {
            self::Chen => 'L.',
            self::Whitaker => 'E.',
            self::Reyes => 'M.',
            self::Kowalski => '',
        };
    }

    public function lastName(): string
    {
        return match ($this) {
            self::Chen => 'Chen',
            self::Whitaker => 'Whitaker',
            self::Reyes => 'Reyes',
            self::Kowalski => 'Kowalski',
        };
    }

    /** ISO `YYYY-MM-DD`. */
    public function dateOfBirth(): string
    {
        return match ($this) {
            self::Chen => '1967-08-14',
            self::Whitaker => '1958-11-03',
            self::Reyes => '1983-12-19',
            self::Kowalski => '1971-06-08',
        };
    }

    /** OpenEMR `patient_data.sex` accepts 'Male' / 'Female' / 'Unspecified'. */
    public function sex(): string
    {
        return match ($this) {
            self::Chen, self::Reyes => 'Female',
            self::Whitaker, self::Kowalski => 'Male',
        };
    }

    public function archetype(): PatientArchetype
    {
        return match ($this) {
            self::Chen => PatientArchetype::Diabetic,
            self::Whitaker => PatientArchetype::ComplexElderly,
            self::Reyes => PatientArchetype::DiabeticUncontrolled,
            self::Kowalski => PatientArchetype::RecentEdVisit,
        };
    }

    /**
     * One representative phone the intake fixture lists — gives the
     * fixture-driven demo a non-Faker number a human can recognise.
     */
    public function phone(): string
    {
        return match ($this) {
            self::Chen => '(510) 555-0148',
            self::Whitaker => '(505) 555-0193',
            self::Reyes => '(512) 555-0177',
            self::Kowalski => '(312) 555-0142',
        };
    }

    /** A stable email that survives re-seeding for the demo login flow. */
    public function email(): string
    {
        return match ($this) {
            self::Chen => 'mchen.demo@example.test',
            self::Whitaker => 'jwhitaker.demo@example.test',
            self::Reyes => 'sreyes.demo@example.test',
            self::Kowalski => 'rkowalski.demo@example.test',
        };
    }

    public function streetAddress(): string
    {
        return match ($this) {
            self::Chen => '4421 Magnolia Ave, Apt 3B',
            self::Whitaker => '812 Rio Grande Blvd NW',
            self::Reyes => '1124 South Lamar Blvd, Apt 214',
            self::Kowalski => '3318 W Belmont Ave',
        };
    }

    public function city(): string
    {
        return match ($this) {
            self::Chen => 'Berkeley',
            self::Whitaker => 'Albuquerque',
            self::Reyes => 'Austin',
            self::Kowalski => 'Chicago',
        };
    }

    public function stateAbbr(): string
    {
        return match ($this) {
            self::Chen => 'CA',
            self::Whitaker => 'NM',
            self::Reyes => 'TX',
            self::Kowalski => 'IL',
        };
    }

    public function postalCode(): string
    {
        return match ($this) {
            self::Chen => '94705',
            self::Whitaker => '87107',
            self::Reyes => '78704',
            self::Kowalski => '60618',
        };
    }

    /**
     * Build a PatientService::insert payload for this fixture. Mirrors
     * the shape produced by `PatientGenerator::generate()` so OpenEMR's
     * normal validation, UUID minting, and event-dispatch fire exactly
     * as for every other seeded patient.
     *
     * @return array<string, string|int>
     */
    public function toPatientData(int $pcpUserId): array
    {
        return [
            'fname'        => $this->firstName(),
            'lname'        => $this->lastName(),
            'mname'        => $this->middleName(),
            'sex'          => $this->sex(),
            'DOB'          => $this->dateOfBirth(),
            'street'       => $this->streetAddress(),
            'city'         => $this->city(),
            'state'        => $this->stateAbbr(),
            'postal_code'  => $this->postalCode(),
            'country_code' => 'US',
            'phone_home'   => $this->phone(),
            'phone_cell'   => $this->phone(),
            'email'        => $this->email(),
            'language'     => 'English',
            'race'         => '',
            'ethnicity'    => '',
            'status'       => '',
            'occupation'   => '',
            'providerID'   => $pcpUserId,
        ];
    }

    /**
     * @return list<self>
     */
    public static function all(): array
    {
        return self::cases();
    }
}
