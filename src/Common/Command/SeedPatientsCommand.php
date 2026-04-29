<?php

/**
 * SeedPatientsCommand generates synthetic patients via PHP Faker and inserts
 * them through OpenEMR's PatientService. Each patient gets light clinical
 * scaffolding: 1-3 encounters, 0-3 problem-list entries, 0-4 medications.
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

namespace OpenEMR\Common\Command;

use Faker\Factory as FakerFactory;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Seed\Generators\EncounterGenerator;
use OpenEMR\Seed\Generators\MedListGenerator;
use OpenEMR\Seed\Generators\PatientGenerator;
use OpenEMR\Seed\Generators\ProblemListGenerator;
use OpenEMR\Services\EncounterService;
use OpenEMR\Services\ListService;
use OpenEMR\Services\PatientService;
use OpenEMR\Services\PrescriptionService;
use OpenEMR\Validators\ProcessingResult;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class SeedPatientsCommand extends Command
{
    private const DEFAULT_COUNT = 100;

    protected function configure(): void
    {
        $this
            ->setName('seed:patients')
            ->setDescription('Generate N Faker-synthesised patients with light clinical scaffolding (encounters, problems, meds).')
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

        $patientGen = new PatientGenerator($faker);
        $encounterGen = new EncounterGenerator($faker);
        $problemGen = new ProblemListGenerator($faker);
        $medGen = new MedListGenerator($faker);

        $patientService = new PatientService();
        $encounterService = new EncounterService();
        $listService = new ListService();
        $prescriptionService = new PrescriptionService();

        $io->section("Generating {$count} patient(s)");
        $io->progressStart($count);

        $stats = [
            'patients' => 0,
            'encounters' => 0,
            'problems' => 0,
            'medications' => 0,
            'failed_patients' => 0,
        ];
        $start = microtime(true);

        for ($i = 0; $i < $count; $i++) {
            $providerId = $providerIds[array_rand($providerIds)];

            $patientData = $patientGen->generate();
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

            $encounterCount = $faker->numberBetween(1, 3);
            for ($e = 0; $e < $encounterCount; $e++) {
                $encounterData = $encounterGen->generate($providerId);
                $encResult = $encounterService->insertEncounter($puuid, $encounterData);
                if ($encResult->isValid() && !$encResult->hasInternalErrors()) {
                    $stats['encounters']++;
                }
            }

            $problemCount = $faker->numberBetween(0, 3);
            for ($p = 0; $p < $problemCount; $p++) {
                $problemData = $problemGen->generate($pid);
                $listService->insert($problemData);
                $stats['problems']++;
            }

            $medCount = $faker->numberBetween(0, 4);
            for ($m = 0; $m < $medCount; $m++) {
                $medData = $medGen->generate($pid, $providerId);
                $rxResult = $prescriptionService->insert($medData);
                if (!$rxResult->hasInternalErrors() && $rxResult->isValid()) {
                    $stats['medications']++;
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
                ['failed patients', $stats['failed_patients']],
            ]
        );
        $io->success("Done in {$elapsed}s.");
        return $stats['failed_patients'] === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    /**
     * Pick provider user ids from the users table. Falls back to the
     * authorized=1 users (which is OpenEMR's "is a provider" flag) and
     * filters out the dummy 'unassigned' row at id=0.
     *
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
