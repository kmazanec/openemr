<?php

/**
 * Test factory that turns a PatientArchetype + Faker seed into the row
 * shapes every ChartSnapshot adapter consumes. The clinical content
 * (ICD codes, drug names, dose strings, lab analytes, abnormal flags)
 * comes from the production seed generators in `bin/seed/Generators/`,
 * so the same archetype contract that drives `seed:patients` drives
 * the tests.
 *
 * The factory exists because adapter rows have different keys than the
 * seed-row payloads (which target `PatientService::insert()` etc.). The
 * shape translation is intentionally narrow: only the columns each
 * adapter actually reads survive; everything else is dropped.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype;

use Faker\Factory as FakerFactory;
use Faker\Generator as Faker;
use OpenEMR\Seed\Generators\AllergyGenerator;
use OpenEMR\Seed\Generators\AppointmentGenerator;
use OpenEMR\Seed\Generators\EncounterGenerator;
use OpenEMR\Seed\Generators\LabResultGenerator;
use OpenEMR\Seed\Generators\MedListGenerator;
use OpenEMR\Seed\Generators\ProblemListGenerator;
use OpenEMR\Seed\Generators\VisitReasonPicker;
use OpenEMR\Seed\PatientArchetype;

final readonly class ArchetypeChartFactory
{
    /** Today, frozen so observation lookback windows are deterministic. */
    public const TODAY = '2026-04-30';

    /** Default pid used by tests; arbitrary but stable. */
    public const DEFAULT_PID = 4242;

    /** Default practitioner uuid for AppointmentAdapter calls. */
    public const PRACTITIONER_UUID = '550e8400-e29b-41d4-a716-446655440099';

    public function __construct(private int $seed)
    {
    }

    public function build(PatientArchetype $archetype, int $pid = self::DEFAULT_PID): ArchetypeChart
    {
        $faker = FakerFactory::create('en_US');
        // Compose the archetype into the seed so different archetypes produce
        // different streams even at the same caller-supplied seed value.
        $faker->seed($this->seed + crc32($archetype->value));

        $patientRow = $this->buildPatientRow($faker, $archetype, $pid);
        $conditionRows = $this->buildConditionRows($faker, $archetype, $pid);
        $prescriptionRows = $this->buildPrescriptionRows($faker, $archetype, $pid);
        $allergyRows = $this->buildAllergyRows($faker, $archetype, $pid);
        $encounterRows = $this->buildEncounterRows($faker, $archetype);
        $observationRows = $this->buildObservationRows($faker, $archetype);
        $appointmentRow = $this->buildAppointmentRow($faker, $archetype);
        $reminderRows = $this->buildReminderRows($archetype);
        $medicationStatementRows = $this->buildMedicationStatementRows($archetype);

        $uuid = $patientRow['uuid'];
        if (!is_string($uuid)) {
            throw new \LogicException('factory must produce a string uuid');
        }

        return new ArchetypeChart(
            archetype: $archetype,
            pid: $pid,
            uuid: $uuid,
            patientRow: $patientRow,
            conditionRows: $conditionRows,
            prescriptionRows: $prescriptionRows,
            allergyRows: $allergyRows,
            encounterRows: $encounterRows,
            observationRows: $observationRows,
            appointmentRow: $appointmentRow,
            groundTruth: ArchetypeGroundTruth::forArchetype($archetype),
            reminderRows: $reminderRows,
            medicationStatementRows: $medicationStatementRows,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function buildPatientRow(Faker $faker, PatientArchetype $archetype, int $pid): array
    {
        $generator = new \OpenEMR\Seed\Generators\PatientGenerator($faker);
        $row = $generator->generate($archetype, pcpUserId: 1);
        // Production wiring's PatientDataSource returns the row plus pid/uuid;
        // PatientService::insert() mints the uuid in real life. For the test
        // factory we synthesize a deterministic v4-shaped uuid from the seed.
        $row['pid'] = $pid;
        $row['uuid'] = $this->deterministicUuid($archetype->value . ':patient:' . $pid);
        return $row;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function buildConditionRows(Faker $faker, PatientArchetype $archetype, int $pid): array
    {
        $generator = new ProblemListGenerator($faker);
        $rows = [];
        $idCounter = 0;
        foreach ($archetype->requiredProblems() as $problem) {
            $seedRow = $generator->generateRequired($pid, $problem['code'], $problem['title']);
            $rows[] = $this->mapConditionRow($seedRow, ++$idCounter);
        }
        // ConditionAdapter reads `lists` rows. The seed pipeline layers extra
        // weighted picks; we add a single deterministic extra so tests have
        // a non-trivial list without flaky size variance.
        if ($archetype !== PatientArchetype::HealthyAdult) {
            $extra = $generator->generateRandom($pid);
            $rows[] = $this->mapConditionRow($extra, ++$idCounter);
        }
        return $rows;
    }

    /**
     * @param array<string, mixed> $seedRow
     * @return array<string, mixed>
     */
    private function mapConditionRow(array $seedRow, int $id): array
    {
        // ConditionAdapter consumes columns: id, diagnosis, title, date.
        // The seed row produces `pid/type/title/begdate/enddate/diagnosis`.
        return [
            'id'        => $id,
            'diagnosis' => $seedRow['diagnosis'],
            'title'     => $seedRow['title'],
            'date'      => $seedRow['begdate'],
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function buildPrescriptionRows(Faker $faker, PatientArchetype $archetype, int $pid): array
    {
        $generator = new MedListGenerator($faker);
        $rows = [];
        $id = 0;
        foreach ($archetype->requiredMedicationRxcuis() as $rxcui) {
            $seedRow = $generator->generateByRxcui(
                pid: $pid,
                providerId: 1,
                rxcui: $rxcui,
                indication: $archetype->indicationForRxcui($rxcui),
            );
            $rows[] = $this->mapPrescriptionRow($seedRow, ++$id);
        }
        return $rows;
    }

    /**
     * @param array<string, mixed> $seedRow
     * @return array<string, mixed>
     */
    private function mapPrescriptionRow(array $seedRow, int $id): array
    {
        // PrescriptionAdapter consumes id/drug/dosage/active/route_title/
        // interval_title/date_added/date_modified/prescriber/indication.
        // Seed row provides drug+dosage+start_date+date_added+indication.
        // route_title and interval_title come from OpenEMR's prescriptions
        // JOIN onto list_options in production; the test fixture supplies
        // fixed values (not exercised by the seed generator). All
        // archetype rows ship as active=1; inactive-with-stop coverage
        // lives in the adapter unit test.
        return [
            'id'              => $id,
            'drug'            => $seedRow['drug'],
            'dosage'          => $seedRow['dosage'],
            'active'          => 1,
            'route_title'     => 'Oral',
            'interval_title'  => 'Twice a day',
            'date_added'      => $seedRow['date_added'],
            'date_modified'   => null,
            'prescriber'      => 'Patel, Maya',
            'indication'      => $seedRow['indication'] ?? null,
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function buildAllergyRows(Faker $faker, PatientArchetype $archetype, int $pid): array
    {
        // The seed pipeline gives ~35% of patients an allergy; for the
        // deterministic test fixture we always emit one allergy except
        // for HealthyAdult, which surfaces NKDA (the meaningful empty
        // state called out in `AllergyGenerator`).
        if ($archetype === PatientArchetype::HealthyAdult) {
            return [];
        }
        $generator = new AllergyGenerator($faker);
        $seedRow = $generator->generate($pid);
        return [[
            'id'             => 1,
            'title'          => $seedRow['title'],
            'date'           => $seedRow['begdate'],
            'reaction_title' => $seedRow['reaction'],
            'severity_al'    => $seedRow['severity_al'],
        ]];
    }

    /**
     * Phase 4.6.3: deterministic reminder rows for archetypes that
     * carry an actionable overdue/due item. ComplexElderly gains an
     * overdue mammogram (the canonical "fell off the schedule" case);
     * DiabeticUncontrolled gains an A1c follow-up to surface the
     * pattern where uncontrolled diabetes implies a tighter recall.
     * Other archetypes return empty so the existing UC1 happy path
     * stays unchanged.
     *
     * Row shape mirrors the production query's projection (the
     * COALESCE-resolved `*_title` columns plus the raw codes), so
     * `ReminderAdapter::mapRow` walks the same fields under both
     * data sources.
     *
     * @return list<array<string, mixed>>
     */
    private function buildReminderRows(PatientArchetype $archetype): array
    {
        return match ($archetype) {
            PatientArchetype::ComplexElderly => [
                [
                    'id'                => 85001,
                    'pid'               => 5005,
                    'due_status'        => 'overdue',
                    'category'          => 'screening',
                    'item'              => 'mammogram',
                    'date_created'      => '2025-11-01',
                    'due_status_title'  => 'overdue',
                    'category_title'    => 'Screening',
                    'item_title'        => 'Mammogram screening',
                    'item_title_raw'    => 'Mammogram screening',
                ],
            ],
            PatientArchetype::DiabeticUncontrolled => [
                [
                    'id'                => 85002,
                    'pid'               => 4004,
                    'due_status'        => 'due',
                    'category'          => 'lab_followup',
                    'item'              => 'a1c_recheck',
                    'date_created'      => '2026-04-01',
                    'due_status_title'  => 'due',
                    'category_title'    => 'Lab follow-up',
                    'item_title'        => 'A1c follow-up',
                    'item_title_raw'    => 'A1c follow-up',
                ],
            ],
            default => [],
        };
    }

    /**
     * Phase 4.6.4: deterministic patient-reported medication
     * (`MedicationStatement`) rows. ComplexElderly carries an OTC
     * Tylenol entry — the canonical "patient is medicating chronic
     * pain on their own" case for a multi-condition older adult.
     * Other archetypes return empty so the existing UC1 happy path
     * stays unchanged.
     *
     * Row shape mirrors the production query: `lists.title`,
     * `lists.begdate`, `lists.enddate`, and the
     * `lists_medication.*` denormalized fields plus the resolved
     * `information_source_title`.
     *
     * @return list<array<string, mixed>>
     */
    private function buildMedicationStatementRows(PatientArchetype $archetype): array
    {
        return match ($archetype) {
            PatientArchetype::ComplexElderly => [
                [
                    'id'                          => 95001,
                    'pid'                         => 5005,
                    'title'                       => 'Tylenol',
                    'begdate'                     => '2024-06-01',
                    'enddate'                     => null,
                    'date'                        => '2024-06-01',
                    'drug_dosage_instructions'    => '500 mg as needed',
                    'usage_category_title'        => 'OTC',
                    'information_source_title'    => 'Patient',
                ],
            ],
            default => [],
        };
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function buildEncounterRows(Faker $faker, PatientArchetype $archetype): array
    {
        $reasonPicker = new VisitReasonPicker($faker);
        $generator = new EncounterGenerator($faker, $reasonPicker);
        // EncounterAdapter consumes encounter/encounter_date/encounter_type/
        // reason. Seed row produces date/reason/class_code/provider_id/...
        $rows = [];
        $count = $archetype->encounterCountRange()[0]; // floor of the range, deterministic
        for ($i = 0; $i < $count; $i++) {
            $seedRow = $generator->generate(providerId: 1, archetype: $archetype);
            $rows[] = [
                'encounter'      => 1000 + $i,
                'encounter_date' => substr((string) $seedRow['date'], 0, 10),
                'encounter_type' => 'office-visit',
                'reason'         => $seedRow['reason'],
            ];
        }
        return $rows;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function buildObservationRows(Faker $faker, PatientArchetype $archetype): array
    {
        $generator = new LabResultGenerator($faker);
        $series = $generator->generateForArchetype($archetype);
        $rows = [];
        $id = 0;
        foreach ($series as $panel) {
            foreach ($panel->draws as $draw) {
                foreach ($draw->results as $result) {
                    $rows[] = [
                        'id'          => ++$id,
                        'analyte'     => $result['name'],
                        'value'       => $result['value'],
                        'units'       => $result['units'],
                        'range'       => $result['range'],
                        'abnormal'    => $result['abnormal'],
                        'observed_at' => $draw->date->format('Y-m-d'),
                    ];
                }
            }
        }
        return $rows;
    }

    /**
     * @return array<string, mixed>
     */
    private function buildAppointmentRow(Faker $faker, PatientArchetype $archetype): array
    {
        $generator = new AppointmentGenerator(new VisitReasonPicker($faker));
        $seedRow = $generator->generate(
            archetype: $archetype,
            providerId: 1,
            date: self::TODAY,
            startTime: '09:30:00',
            apptStatus: '-',
        );
        return [
            'pc_eid'       => 9001,
            'pc_eventDate' => $seedRow['pc_eventDate'],
            'pc_startTime' => $seedRow['pc_startTime'],
            'pc_duration'  => $seedRow['pc_duration'],
            'pc_catname'   => 'Established Patient',
            'pc_title'     => $seedRow['pc_title'],
        ];
    }

    /**
     * Deterministic v4-shaped uuid: SHA-1 the input, format with version 4
     * and variant bits set. Stable across runs without adding a dep.
     */
    private function deterministicUuid(string $key): string
    {
        $hash = sha1('archetype-fixture:' . $key);
        return sprintf(
            '%s-%s-4%s-%s%s-%s',
            substr($hash, 0, 8),
            substr($hash, 8, 4),
            substr($hash, 13, 3),
            dechex(0x8 | (hexdec(substr($hash, 16, 1)) & 0x3)),
            substr($hash, 17, 3),
            substr($hash, 20, 12),
        );
    }
}
