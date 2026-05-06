<?php

/**
 * SeedPatientsCommand generates synthetic patients via PHP Faker and inserts
 * them through OpenEMR's PatientService. Each patient is first assigned a
 * clinical archetype (HEALTHY_ADULT, HYPERTENSIVE, DIABETIC,
 * DIABETIC_UNCONTROLLED, COMPLEX_ELDERLY, RECENT_ED_VISIT) which then drives
 * problem/medication/encounter/vitals/allergy generation. This guarantees
 * the data shapes required by the USERS.md briefing scenarios — e.g. every
 * diabetic patient has an E11.9 problem and a metformin prescription, so
 * UC1's "current meds + active diagnoses" briefing is always populated.
 *
 * Pure-additive: every run adds the requested count on top of whatever
 * already exists. To start over, restore baseline.sql.gz.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Common\Command;

use Faker\Factory as FakerFactory;
use Faker\Generator as Faker;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Seed\FixturePatient;
use OpenEMR\Seed\Generators\AllergyGenerator;
use OpenEMR\Seed\Generators\EncounterGenerator;
use OpenEMR\Seed\Generators\EncounterNoteGenerator;
use OpenEMR\Seed\Generators\ExternalEncounterGenerator;
use OpenEMR\Seed\Generators\LabDraw;
use OpenEMR\Seed\Generators\LabResultGenerator;
use OpenEMR\Seed\Generators\LabSeries;
use OpenEMR\Seed\Generators\MedListGenerator;
use OpenEMR\Seed\Generators\NoteContext;
use OpenEMR\Seed\Generators\PatientGenerator;
use OpenEMR\Seed\Generators\ProblemListGenerator;
use OpenEMR\Seed\Generators\VisitReasonPicker;
use OpenEMR\Seed\Generators\VitalsGenerator;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Services\EncounterService;
use OpenEMR\Services\FormService;
use OpenEMR\Services\ListService;
use OpenEMR\Services\PatientService;
use OpenEMR\Services\PrescriptionService;
use OpenEMR\Services\VitalsService;
use OpenEMR\Validators\ProcessingResult;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class SeedPatientsCommand extends Command
{
    private const DEFAULT_COUNT = 100;

    /** Username of the baseline 'physician' user — our Dr. Patel stand-in. */
    private const DEFAULT_PCP_USERNAME = 'physician';

    /** Fraction of patients assigned to the default PCP (rest spread across other providers). */
    private const PCP_PANEL_FRACTION = 70;

    /** Fraction of patients that get any allergy recorded. */
    private const ALLERGY_FRACTION = 35;

    /** Fraction of *random* meds that should land as recently-stopped (active=0, end_date in last 90d). */
    private const STOPPED_MED_FRACTION = 12;

    protected function configure(): void
    {
        $this
            ->setName('seed:patients')
            ->setDescription('Generate N archetype-driven Faker patients with clinical scaffolding (problems, meds, encounters, vitals, allergies).')
            ->addOption(
                'count',
                'c',
                InputOption::VALUE_REQUIRED,
                'Number of patients to generate.',
                (string) self::DEFAULT_COUNT
            )
            ->addOption(
                'seed',
                null,
                InputOption::VALUE_REQUIRED,
                'Optional integer Faker seed for deterministic output (omit for fresh randomness).'
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $countOption = $input->getOption('count');
        $count = is_numeric($countOption) ? (int) $countOption : 0;

        if ($count < 1) {
            $io->error('--count must be a positive integer.');
            return Command::FAILURE;
        }

        $faker = FakerFactory::create('en_US');
        $seedOption = $input->getOption('seed');
        if (is_numeric($seedOption)) {
            $faker->seed((int) $seedOption);
        }

        $providerIds = $this->loadProviderIds();
        if ($providerIds === []) {
            $io->error('No provider users found in the users table. Restore the baseline first.');
            return Command::FAILURE;
        }
        $defaultPcpId = $this->loadDefaultPcpId() ?? $providerIds[0];

        // Several services (encounter saves, vitals calc, calendar inserts) read
        // authUserID from the session. In CLI we have none, so attribute every
        // seeded write to the default PCP user.
        SessionUtil::setSession('authUserID', $defaultPcpId);

        $reasonPicker = new VisitReasonPicker($faker);
        $patientGen = new PatientGenerator($faker);
        $encounterGen = new EncounterGenerator($faker, $reasonPicker);
        $problemGen = new ProblemListGenerator($faker);
        $medGen = new MedListGenerator($faker);
        $allergyGen = new AllergyGenerator($faker);
        $vitalsGen = new VitalsGenerator($faker);
        $labGen = new LabResultGenerator($faker);
        $noteGen = new EncounterNoteGenerator($faker);
        $extEncGen = new ExternalEncounterGenerator($faker);

        $patientService = new PatientService();
        $encounterService = new EncounterService();
        $listService = new ListService();
        $prescriptionService = new PrescriptionService();
        $vitalsService = new VitalsService();

        $stats = [
            'patients' => 0,
            'fixture_patients' => 0,
            'encounters' => 0,
            'problems' => 0,
            'medications' => 0,
            'allergies' => 0,
            'vitals' => 0,
            'lab_orders' => 0,
            'lab_results' => 0,
            'stopped_meds' => 0,
            'soap_notes' => 0,
            'prescribing_encounters' => 0,
            'external_encounters' => 0,
            'failed_patients' => 0,
        ];
        $archetypeCounts = [];
        $start = microtime(true);

        // Fixture patients first (deterministic, independent of --count) so
        // every run wires the docs/example-documents/ test fixtures to
        // recognisable charts. Skipped when one with the same lname+DOB
        // already exists so re-running the seed without baseline restore
        // is idempotent.
        $io->section('Pinning fixture patients (' . count(FixturePatient::cases()) . ')');
        foreach (FixturePatient::cases() as $fixture) {
            if ($this->fixturePatientExists($fixture)) {
                continue;
            }
            $archetype = $fixture->archetype();
            $patientData = $fixture->toPatientData($defaultPcpId);
            $insert = $this->insertPatientRecord($patientService, $patientData, $defaultPcpId, $stats, $io);
            if ($insert === null) {
                continue;
            }
            $stats['fixture_patients']++;
            $archetypeCounts[$archetype->value] = ($archetypeCounts[$archetype->value] ?? 0) + 1;
            $this->scaffoldClinicalRecord(
                $insert['pid'],
                $insert['puuid'],
                $defaultPcpId,
                $archetype,
                $faker,
                $stats,
                $encounterGen,
                $problemGen,
                $medGen,
                $allergyGen,
                $vitalsGen,
                $labGen,
                $noteGen,
                $extEncGen,
                $encounterService,
                $listService,
                $prescriptionService,
                $vitalsService,
            );
        }

        $io->section("Generating {$count} patient(s)");
        $io->progressStart($count);

        for ($i = 0; $i < $count; $i++) {
            $archetype = $this->pickArchetype($faker);
            $archetypeCounts[$archetype->value] = ($archetypeCounts[$archetype->value] ?? 0) + 1;

            $pcpId = $faker->numberBetween(1, 100) <= self::PCP_PANEL_FRACTION
                ? $defaultPcpId
                : $providerIds[array_rand($providerIds)];

            $patientData = $patientGen->generate($archetype, $pcpId);
            $insert = $this->insertPatientRecord($patientService, $patientData, $pcpId, $stats, $io);
            if ($insert === null) {
                $io->progressAdvance();
                continue;
            }
            $this->scaffoldClinicalRecord(
                $insert['pid'],
                $insert['puuid'],
                $pcpId,
                $archetype,
                $faker,
                $stats,
                $encounterGen,
                $problemGen,
                $medGen,
                $allergyGen,
                $vitalsGen,
                $labGen,
                $noteGen,
                $extEncGen,
                $encounterService,
                $listService,
                $prescriptionService,
                $vitalsService,
            );

            $io->progressAdvance();
        }

        $io->progressFinish();
        $elapsed = round(microtime(true) - $start, 1);

        $io->table(
            ['inserted', 'count'],
            [
                ['patients', $stats['patients']],
                ['encounters', $stats['encounters']],
                ['problems', $stats['problems']],
                ['medications', $stats['medications']],
                ['allergies', $stats['allergies']],
                ['vitals rows', $stats['vitals']],
                ['lab orders', $stats['lab_orders']],
                ['lab results', $stats['lab_results']],
                ['stopped meds', $stats['stopped_meds']],
                ['SOAP notes', $stats['soap_notes']],
                ['prescribing encounters', $stats['prescribing_encounters']],
                ['external encounters', $stats['external_encounters']],
                ['fixture patients', $stats['fixture_patients']],
                ['failed patients', $stats['failed_patients']],
            ]
        );
        $archetypeRows = [];
        foreach (PatientArchetype::cases() as $case) {
            $archetypeRows[] = [$case->value, $archetypeCounts[$case->value] ?? 0];
        }
        $io->table(['archetype', 'count'], $archetypeRows);

        $io->success("Done in {$elapsed}s.");
        return $stats['failed_patients'] === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    private function pickArchetype(Faker $faker): PatientArchetype
    {
        $distribution = PatientArchetype::distribution();
        $total = array_sum($distribution);
        $roll = $faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach ($distribution as $value => $weight) {
            $cumulative += $weight;
            if ($roll <= $cumulative) {
                return PatientArchetype::from($value);
            }
        }
        return PatientArchetype::HealthyAdult;
    }

    /**
     * Insert one patient_data row via PatientService and post-patch the
     * provider link. Returns null on any insert / shape failure (caller
     * has already incremented the failed_patients counter).
     *
     * @param array<string, string|int> $patientData
     * @param array<string, int> $stats
     * @return array{pid: int, puuid: string}|null
     */
    private function insertPatientRecord(
        PatientService $patientService,
        array $patientData,
        int $pcpId,
        array &$stats,
        SymfonyStyle $io,
    ): ?array {
        $result = $patientService->insert($patientData);
        if (!$result->isValid() || $result->hasInternalErrors()) {
            $io->writeln('');
            $io->warning('Patient insert failed: ' . $this->describeProcessingResult($result));
            $stats['failed_patients']++;
            return null;
        }
        $resultData = $result->getData();
        if (!is_array($resultData) || !isset($resultData[0]) || !is_array($resultData[0])) {
            $stats['failed_patients']++;
            return null;
        }
        $insertRow = $resultData[0];
        $pid = isset($insertRow['pid']) && is_numeric($insertRow['pid']) ? (int) $insertRow['pid'] : 0;
        $puuid = isset($insertRow['uuid']) && is_string($insertRow['uuid']) ? $insertRow['uuid'] : '';
        if ($pid === 0 || $puuid === '') {
            $stats['failed_patients']++;
            return null;
        }
        $stats['patients']++;

        // PatientService::insert filters providerID out of its allowlist,
        // so set the PCP directly. This is what makes UC1's partner-coverage
        // vs. own-panel distinction work.
        QueryUtils::sqlStatementThrowException(
            'UPDATE patient_data SET providerID = ? WHERE pid = ?',
            [$pcpId, $pid]
        );

        return ['pid' => $pid, 'puuid' => $puuid];
    }

    /**
     * Lookup helper for the fixture pre-loop. A fixture patient is
     * considered "already present" if any patient_data row matches both
     * lname and DOB — re-running the seed without restoring baseline is
     * idempotent for the four pinned fixtures, so demos can layer
     * additional Faker patients on top without duplicating Chen et al.
     */
    private function fixturePatientExists(FixturePatient $fixture): bool
    {
        $row = QueryUtils::fetchSingleValue(
            'SELECT pid FROM patient_data WHERE lname = ? AND DOB = ? LIMIT 1',
            'pid',
            [$fixture->lastName(), $fixture->dateOfBirth()]
        );
        return is_numeric($row) && (int) $row > 0;
    }

    /**
     * Run the per-patient clinical-scaffolding pipeline (problems →
     * meds → prescribing encounters → allergy → labs → external
     * encounters → regular encounters with vitals + SOAP). Extracted so
     * both the fixture-patient pre-loop and the random-patient loop run
     * the exact same sequence — only the patient identity differs.
     *
     * @param array<string, int> $stats
     */
    private function scaffoldClinicalRecord(
        int $pid,
        string $puuid,
        int $pcpId,
        PatientArchetype $archetype,
        Faker $faker,
        array &$stats,
        EncounterGenerator $encounterGen,
        ProblemListGenerator $problemGen,
        MedListGenerator $medGen,
        AllergyGenerator $allergyGen,
        VitalsGenerator $vitalsGen,
        LabResultGenerator $labGen,
        EncounterNoteGenerator $noteGen,
        ExternalEncounterGenerator $extEncGen,
        EncounterService $encounterService,
        ListService $listService,
        PrescriptionService $prescriptionService,
        VitalsService $vitalsService,
    ): void {
        // Required problems first, then a few random extras.
        foreach ($archetype->requiredProblems() as $required) {
            $listService->insert($problemGen->generateRequired($pid, $required['code'], $required['title']));
            $stats['problems']++;
        }
        [$pMin, $pMax] = $archetype->extraProblemRange();
        $extraProblems = $faker->numberBetween($pMin, $pMax);
        for ($p = 0; $p < $extraProblems; $p++) {
            $listService->insert($problemGen->generateRandom($pid));
            $stats['problems']++;
        }

        // Required medications: each one gets a synthesised
        // "prescribing encounter" 4-8 weeks ago whose SOAP note
        // explicitly names the drug + indication. That encounter's
        // date becomes the prescription's start_date so UC3's
        // "when/why was lisinopril started" drill-down can cite a
        // concrete, navigable visit.
        $stableHeight = (float) $faker->numberBetween(60, 74);
        $baselineWeight = $this->baselineWeightFor($archetype, $stableHeight, $faker);
        foreach ($archetype->requiredMedicationRxcuis() as $rxcui) {
            $indication = $archetype->indicationForRxcui($rxcui) ?? 'chronic condition';
            $weeksAgo = $faker->numberBetween(4, 8);
            $encDate = (new \DateTimeImmutable("-{$weeksAgo} weeks"))->format('Y-m-d H:i:s');

            $encId = $this->insertPrescribingEncounter(
                $puuid,
                $pcpId,
                $encDate,
                $indication,
                $encounterService,
            );
            if ($encId === 0) {
                continue;
            }
            $stats['encounters']++;
            $stats['prescribing_encounters']++;

            // Vitals on the prescribing visit.
            try {
                $vitalsService->save($vitalsGen->generate(
                    $pid, $encId, $encDate, $archetype, $stableHeight, $baselineWeight,
                ));
                $stats['vitals']++;
            } catch (\RuntimeException | \InvalidArgumentException) {
            }

            // Build the prescription with start_date pinned to the encounter.
            $rxRow = $medGen->generateByRxcui(
                $pid,
                $pcpId,
                $rxcui,
                substr($encDate, 0, 10),
                $indication,
            );
            $rxResult = $prescriptionService->insert($rxRow);
            if (!$rxResult->hasInternalErrors() && $rxResult->isValid()) {
                $stats['medications']++;
            }

            // SOAP note that names the drug and indication.
            $drugName = isset($rxRow['drug']) && is_string($rxRow['drug']) ? $rxRow['drug'] : 'medication';
            $soap = $noteGen->generatePrescribingNote(
                $drugName,
                $indication,
                $this->bareNoteContext($archetype, $stableHeight, $baselineWeight, $faker),
            );
            if ($this->insertSoapForm($pid, $encId, $encDate, $pcpId, $soap)) {
                $stats['soap_notes']++;
            }
        }
        [$mMin, $mMax] = $archetype->extraMedicationRange();
        $extraMeds = $faker->numberBetween($mMin, $mMax);
        for ($m = 0; $m < $extraMeds; $m++) {
            $row = $medGen->generateRandom($pid, $pcpId);
            $isStopped = $faker->numberBetween(1, 100) <= self::STOPPED_MED_FRACTION;
            if ($isStopped) {
                $row = $medGen->markStopped($row);
            }
            $rxResult = $prescriptionService->insert($row);
            if (!$rxResult->hasInternalErrors() && $rxResult->isValid()) {
                $stats['medications']++;
                if ($isStopped) {
                    $stats['stopped_meds']++;
                }
            }
        }

        // Allergy: ~35% of patients get one. ListService::insert only
        // writes 6 columns, so patch reaction/severity_al in afterward.
        if ($faker->numberBetween(1, 100) <= self::ALLERGY_FRACTION) {
            $allergyData = $allergyGen->generate($pid);
            $listId = $listService->insert($allergyData);
            if (is_numeric($listId) && (int) $listId > 0) {
                QueryUtils::sqlStatementThrowException(
                    'UPDATE lists SET reaction = ?, severity_al = ? WHERE id = ?',
                    [$allergyData['reaction'], $allergyData['severity_al'], (int) $listId]
                );
            }
            $stats['allergies']++;
        }

        // Lab series — generated up-front so the encounter notes
        // below can reference the most recent A1c/abnormal value.
        $series = $labGen->generateForArchetype($archetype);
        $opportunistic = $labGen->generateOpportunisticAbnormal();
        if ($opportunistic !== null) {
            $series[] = $opportunistic;
        }
        foreach ($series as $panel) {
            foreach ($panel->draws as $draw) {
                $resultsCount = $this->insertLabDraw($pid, $pcpId, $panel, $draw);
                $stats['lab_orders']++;
                $stats['lab_results'] += $resultsCount;
            }
        }
        $noteCtx = $this->buildNoteContext($archetype, $stableHeight, $baselineWeight, $series, $faker);

        // External encounters (UC4): ED visits + outside consults
        // imported from other facilities.
        foreach ($extEncGen->generate($pid, $archetype) as $extRow) {
            QueryUtils::sqlStatementThrowException(
                'INSERT INTO external_encounters (ee_pid, ee_date, ee_facility_id, ee_encounter_diagnosis, ee_external_id)
                 VALUES (?, ?, ?, ?, ?)',
                [$pid, $extRow['ee_date'], $extRow['ee_facility_id'], $extRow['ee_encounter_diagnosis'], $extRow['ee_external_id']]
            );
            $stats['external_encounters']++;
        }

        // Regular encounters with vitals + SOAP notes attached.
        [$eMin, $eMax] = $archetype->encounterCountRange();
        $encounterCount = $faker->numberBetween($eMin, $eMax);
        for ($encIdx = 0; $encIdx < $encounterCount; $encIdx++) {
            $encounterData = $encounterGen->generate($pcpId, $archetype);
            $encResult = $encounterService->insertEncounter($puuid, $encounterData);
            if (!$encResult->isValid() || $encResult->hasInternalErrors()) {
                continue;
            }
            $stats['encounters']++;

            $encRow = $encResult->getData();
            if (!is_array($encRow) || !isset($encRow[0]) || !is_array($encRow[0])) {
                continue;
            }
            $eid = isset($encRow[0]['encounter']) && is_numeric($encRow[0]['encounter'])
                ? (int) $encRow[0]['encounter'] : 0;
            $eDate = isset($encRow[0]['date']) && is_string($encRow[0]['date'])
                ? $encRow[0]['date'] : ($encounterData['date'] ?? date('Y-m-d H:i:s'));
            if ($eid === 0) {
                continue;
            }

            try {
                $vitalsService->save($vitalsGen->generate(
                    $pid,
                    $eid,
                    (string) $eDate,
                    $archetype,
                    $stableHeight,
                    $baselineWeight,
                ));
                $stats['vitals']++;
            } catch (\RuntimeException | \InvalidArgumentException) {
                // VitalsService throws InvalidArgumentException on shape issues,
                // RuntimeException on save failures. Don't abort the patient.
            }

            $reason = isset($encounterData['reason']) && is_string($encounterData['reason'])
                ? $encounterData['reason'] : 'Follow-up visit';
            $soap = $noteGen->generate($reason, $noteCtx);
            if ($this->insertSoapForm($pid, $eid, (string) $eDate, $pcpId, $soap)) {
                $stats['soap_notes']++;
            }
        }
    }

    /**
     * Reasonable adult baseline pounds — caller jitters per encounter.
     */
    private function baselineWeightFor(PatientArchetype $archetype, float $heightInches, Faker $faker): float
    {
        $heightMeters = $heightInches * 0.0254;
        $bmi = $archetype->vitalsBaseline()['bmi'] + $faker->randomFloat(1, -1.5, 1.5);
        $kg = $bmi * $heightMeters * $heightMeters;
        return round($kg / 0.45359237, 1);
    }

    /**
     * Persist one lab draw — a single procedure_order + its
     * procedure_order_code rows, a single procedure_report, and one
     * procedure_result per LOINC test. There's no write-side service for
     * these tables in OpenEMR, so we INSERT directly. Returns the number of
     * procedure_result rows written.
     */
    private function insertLabDraw(int $pid, int $providerId, LabSeries $panel, LabDraw $draw): int
    {
        $orderUuid = (new UuidRegistry())->createUuid();
        $reportUuid = (new UuidRegistry())->createUuid();
        $drawDateTime = $draw->date->format('Y-m-d') . ' 09:00:00';

        $orderId = QueryUtils::sqlInsert(
            "INSERT INTO procedure_order SET
                uuid = ?, provider_id = ?, patient_id = ?, encounter_id = 0,
                date_collected = ?, date_ordered = ?, order_priority = 'normal',
                order_status = 'complete', activity = 1, lab_id = 0,
                specimen_type = ?, procedure_order_type = 'laboratory_test',
                order_intent = 'order'",
            [$orderUuid, $providerId, $pid, $drawDateTime, $drawDateTime, $panel->specimenType]
        );

        QueryUtils::sqlStatementThrowException(
            "INSERT INTO procedure_order_code SET
                procedure_order_id = ?, procedure_order_seq = 1,
                procedure_code = ?, procedure_name = ?,
                procedure_source = '1', procedure_type = 'lab'",
            [$orderId, $panel->panelCode, $panel->panelName]
        );

        $reportId = QueryUtils::sqlInsert(
            "INSERT INTO procedure_report SET
                uuid = ?, procedure_order_id = ?, procedure_order_seq = 1,
                date_collected = ?, date_report = ?, source = ?,
                report_status = 'complete', review_status = 'reviewed'",
            [$reportUuid, $orderId, $drawDateTime, $drawDateTime, $providerId]
        );

        $resultCount = 0;
        foreach ($draw->results as $result) {
            $resultUuid = (new UuidRegistry())->createUuid();
            QueryUtils::sqlStatementThrowException(
                "INSERT INTO procedure_result SET
                    uuid = ?, procedure_report_id = ?, result_data_type = 'N',
                    result_code = ?, result_text = ?, date = ?,
                    units = ?, result = ?, `range` = ?, abnormal = ?,
                    result_status = 'final'",
                [
                    $resultUuid,
                    $reportId,
                    $result['loinc'],
                    $result['name'],
                    $drawDateTime,
                    $result['units'],
                    $result['value'],
                    $result['range'],
                    $result['abnormal'],
                ]
            );
            $resultCount++;
        }
        return $resultCount;
    }

    /**
     * Insert a synthesised "prescribing encounter" — the visit where a
     * required med was started. Returns the encounter id (0 on failure).
     * Uses EncounterService so the same validation/event-dispatch fires
     * as for any other encounter.
     */
    private function insertPrescribingEncounter(
        string $puuid,
        int $providerId,
        string $dateTime,
        string $indication,
        EncounterService $encounterService,
    ): int {
        $payload = [
            'date'        => $dateTime,
            'reason'      => 'Initial visit — ' . $indication,
            'pc_catid'    => 1,
            'class_code'  => 'AMB',
            'provider_id' => $providerId,
            'facility_id' => 3,
            'sensitivity' => 'normal',
            'user'        => '',
            'group'       => '',
        ];
        $result = $encounterService->insertEncounter($puuid, $payload);
        if (!$result->isValid() || $result->hasInternalErrors()) {
            return 0;
        }
        $rows = $result->getData();
        if (!is_array($rows) || !isset($rows[0]) || !is_array($rows[0])) {
            return 0;
        }
        return isset($rows[0]['encounter']) && is_numeric($rows[0]['encounter']) ? (int) $rows[0]['encounter'] : 0;
    }

    /**
     * Persist a SOAP note bound to an encounter. There's no service
     * write API for form_soap, so this writes the row and registers it
     * via addForm() — the same path forms.inc.php uses for UI inserts.
     *
     * @param array{subjective: string, objective: string, assessment: string, plan: string} $soap
     */
    private function insertSoapForm(int $pid, int $encounterId, string $dateTime, int $providerId, array $soap): bool
    {
        $formId = QueryUtils::sqlInsert(
            "INSERT INTO form_soap SET
                date = ?, pid = ?, user = ?, groupname = 'Default',
                authorized = 1, activity = 1,
                subjective = ?, objective = ?, assessment = ?, plan = ?",
            [
                $dateTime,
                $pid,
                (string) $providerId,
                $soap['subjective'],
                $soap['objective'],
                $soap['assessment'],
                $soap['plan'],
            ]
        );
        if (!$formId) {
            return false;
        }
        (new FormService())->addForm($encounterId, 'SOAP', $formId, 'soap', $pid, 1, $dateTime, (string) $providerId, '');
        return true;
    }

    /**
     * Build a NoteContext from in-memory archetype defaults + the most
     * recent values in the lab series. Called once per patient so token
     * substitution in encounter notes references coherent chart data.
     *
     * @param list<LabSeries> $series
     */
    private function buildNoteContext(
        PatientArchetype $archetype,
        float $heightInches,
        float $baselineWeight,
        array $series,
        Faker $faker,
    ): NoteContext {
        $baseline = $archetype->vitalsBaseline();
        $bps = $baseline['bps'];
        $bpd = $baseline['bpd'];
        $a1cValue = null;
        foreach ($series as $panel) {
            if ($panel->panelCode === '4548-4' && $panel->draws !== []) {
                $latest = $panel->draws[count($panel->draws) - 1];
                if ($latest->results !== []) {
                    $a1cValue = (float) $latest->results[0]['value'];
                }
            }
        }
        return new NoteContext(
            bp: "{$bps}/{$bpd}",
            bpSystolic: $bps,
            weight: $baselineWeight,
            a1c: $a1cValue !== null ? number_format($a1cValue, 1) : null,
            a1cValue: $a1cValue,
            a1cAgeRelative: $a1cValue !== null ? 'recently' : null,
            medsCsv: null,
            abnormalSummary: null,
        );
    }

    /**
     * Sparse note context for the prescribing-encounter SOAP note —
     * uses archetype defaults only. (Lab values aren't relevant to a
     * note that is itself the *first* visit for the indication.)
     */
    private function bareNoteContext(
        PatientArchetype $archetype,
        float $heightInches,
        float $baselineWeight,
        Faker $faker,
    ): NoteContext {
        $baseline = $archetype->vitalsBaseline();
        return new NoteContext(
            bp: "{$baseline['bps']}/{$baseline['bpd']}",
            bpSystolic: $baseline['bps'],
            weight: $baselineWeight,
        );
    }

    /**
     * @return list<int>
     */
    private function loadProviderIds(): array
    {
        $sql = "SELECT id FROM users WHERE authorized = 1 AND active = 1 AND id > 0";
        $rows = QueryUtils::fetchTableColumn($sql, 'id', []);
        $ids = [];
        foreach ($rows as $row) {
            if (is_numeric($row) && (int) $row > 0) {
                $ids[] = (int) $row;
            }
        }
        return $ids;
    }

    private function loadDefaultPcpId(): ?int
    {
        $row = QueryUtils::fetchSingleValue(
            'SELECT id FROM users WHERE username = ? AND active = 1 LIMIT 1',
            'id',
            [self::DEFAULT_PCP_USERNAME]
        );
        return is_numeric($row) && (int) $row > 0 ? (int) $row : null;
    }

    private function describeProcessingResult(ProcessingResult $result): string
    {
        $messages = [];
        $validationMessages = $result->getValidationMessages();
        if (is_array($validationMessages)) {
            foreach ($validationMessages as $field => $msg) {
                $messages[] = (string) $field . ': ' . $this->stringifyMessage($msg);
            }
        }
        $internalErrors = $result->getInternalErrors();
        if (is_array($internalErrors)) {
            foreach ($internalErrors as $err) {
                if (is_scalar($err)) {
                    $messages[] = (string) $err;
                }
            }
        }
        return $messages === [] ? 'no detail' : implode('; ', $messages);
    }

    private function stringifyMessage(mixed $msg): string
    {
        if (is_array($msg)) {
            $parts = [];
            foreach ($msg as $part) {
                $parts[] = is_scalar($part) ? (string) $part : '[non-scalar]';
            }
            return implode(', ', $parts);
        }
        return is_scalar($msg) ? (string) $msg : '[non-scalar]';
    }
}
