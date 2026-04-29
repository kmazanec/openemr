<?php

/**
 * SeedStatusCommand reports row counts for tables most relevant to the
 * seeded dataset, so an operator can quickly verify what state an
 * environment's database is in.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\Common\Command;

use OpenEMR\Common\Database\QueryUtils;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class SeedStatusCommand extends Command
{
    /**
     * @var array<string, string> table => human label
     */
    private const TABLES = [
        'patient_data' => 'patients',
        'form_encounter' => 'encounters',
        'lists' => 'list items (problems/meds/allergies)',
        'prescriptions' => 'prescriptions',
        'users' => 'users',
    ];

    protected function configure(): void
    {
        $this
            ->setName('seed:status')
            ->setDescription('Report row counts for tables relevant to the seeded dataset.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $rows = [];
        foreach (self::TABLES as $table => $label) {
            $value = QueryUtils::fetchSingleValue(
                "SELECT COUNT(*) FROM `{$table}`",
                'COUNT(*)',
                []
            );
            $count = is_numeric($value) ? (int) $value : 0;
            $rows[] = [$table, number_format($count), $label];
        }

        $io->table(['table', 'rows', 'description'], $rows);
        return Command::SUCCESS;
    }
}
