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
use OpenEMR\Seed\Generators\AllergyGenerator;
use OpenEMR\Seed\Generators\EncounterGenerator;
use OpenEMR\Seed\Generators\MedListGenerator;
use OpenEMR\Seed\Generators\PatientGenerator;
use OpenEMR\Seed\Generators\ProblemListGenerator;
use OpenEMR\Seed\Generators\VisitReasonPicker;
use OpenEMR\Seed\Generators\VitalsGenerator;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Services\EncounterService;
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

        $patientService = new PatientService();
        $encounterService = new EncounterService();
        $listService = new ListService();
        $prescriptionService = new PrescriptionService();
        $vitalsService = new VitalsService();

        $io->section("Generating {$count} patient(s)");
        $io->progressStart($count);

        $stats = [
            'patients' => 0,
            'encounters' => 0,
            'problems' => 0,
            'medications' => 0,
            'allergies' => 0,
            'vitals' => 0,
            'failed_patients' => 0,
        ];
        $archetypeCounts = [];
        $start = microtime(true);

        for ($i = 0; $i < $count; $i++) {
            $archetype = $this->pickArchetype($faker);
            $archetypeCounts[$archetype->value] = ($archetypeCounts[$archetype->value] ?? 0) + 1;

            $pcpId = $faker->numberBetween(1, 100) <= self::PCP_PANEL_FRACTION
                ? $defaultPcpId
                : $providerIds[array_rand($providerIds)];

            $patientData = $patientGen->generate($archetype, $pcpId);
            $result = $patientService->insert($patientData);
            if (!$result->isValid() || $result->hasInternalErrors()) {
                $io->writeln('');
                $io->warning('Patient insert failed: ' . $this->describeProcessingResult($result));
                $stats['failed_patients']++;
                $io->progressAdvance();
                continue;
            }
            $resultData = $result->getData();
            if (!is_array($resultData) || !isset($resultData[0]) || !is_array($resultData[0])) {
                $stats['failed_patients']++;
                $io->progressAdvance();
                continue;
            }
            $insertRow = $resultData[0];
            $pid = isset($insertRow['pid']) && is_numeric($insertRow['pid']) ? (int) $insertRow['pid'] : 0;
            $puuid = isset($insertRow['uuid']) && is_string($insertRow['uuid']) ? $insertRow['uuid'] : '';
            if ($pid === 0 || $puuid === '') {
                $stats['failed_patients']++;
                $io->progressAdvance();
                continue;
            }
            $stats['patients']++;

            // PatientService::insert filters providerID out of its allowlist,
            // so set the PCP directly. This is what makes UC1's partner-coverage
            // vs. own-panel distinction work.
            QueryUtils::sqlStatementThrowException(
                'UPDATE patient_data SET providerID = ? WHERE pid = ?',
                [$pcpId, $pid]
            );

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

            // Required medications (always tied to the patient's PCP), then extras.
            foreach ($archetype->requiredMedicationRxcuis() as $rxcui) {
                $rxResult = $prescriptionService->insert($medGen->generateByRxcui($pid, $pcpId, $rxcui));
                if (!$rxResult->hasInternalErrors() && $rxResult->isValid()) {
                    $stats['medications']++;
                }
            }
            [$mMin, $mMax] = $archetype->extraMedicationRange();
            $extraMeds = $faker->numberBetween($mMin, $mMax);
            for ($m = 0; $m < $extraMeds; $m++) {
                $rxResult = $prescriptionService->insert($medGen->generateRandom($pid, $pcpId));
                if (!$rxResult->hasInternalErrors() && $rxResult->isValid()) {
                    $stats['medications']++;
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

            // Encounters with vitals attached.
            [$eMin, $eMax] = $archetype->encounterCountRange();
            $encounterCount = $faker->numberBetween($eMin, $eMax);
            $stableHeight = (float) $faker->numberBetween(60, 74);
            $baselineWeight = $this->baselineWeightFor($archetype, $stableHeight, $faker);
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
            }

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
