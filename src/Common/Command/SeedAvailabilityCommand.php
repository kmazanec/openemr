<?php

/**
 * SeedAvailabilityCommand inserts weekly recurring 'In Office' (pc_catid=2)
 * and 'Out Of Office' (pc_catid=3) blocks for every authorized provider.
 *
 * Without these blocks OpenEMR's appointment workflow treats every provider
 * as unavailable — patient check-in, the find-appointment popup, and the
 * day/week calendar views all refuse to operate. The upstream baseline
 * dump ships availability rows, but they expire in 2018, so any seeded
 * environment past that date needs current ones.
 *
 * The command leaves the expired baseline rows in place (they came from
 * upstream and aren't ours to delete) and inserts a new pair per provider
 * starting today. It is idempotent: re-running checks for an existing
 * 'In Office' row that already covers today and skips that provider.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Common\Command;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class SeedAvailabilityCommand extends Command
{
    /** Default coverage horizon — six months is plenty for seed/demo use. */
    private const DEFAULT_WEEKS = 26;

    private const DAY_START = '08:00:00';
    private const DAY_END = '17:00:00';

    /** Calendar category ids — these are stable across upstream installs. */
    private const CAT_IN_OFFICE = 2;
    private const CAT_OUT_OF_OFFICE = 3;

    /**
     * Recurrence spec OpenEMR expects in pc_recurrspec — serialized PHP
     * array meaning "every 1 week" (event_repeat_freq_type=4 is weekly).
     * Matches the shape upstream uses for its baseline availability rows.
     */
    private const RECUR_WEEKLY_SPEC = [
        'event_repeat_freq' => '1',
        'event_repeat_freq_type' => '4',
        'event_repeat_on_num' => '1',
        'event_repeat_on_day' => '0',
        'event_repeat_on_freq' => '0',
        'exdate' => '',
    ];

    protected function configure(): void
    {
        $this
            ->setName('seed:availability')
            ->setDescription('Insert weekly In Office / Out Of Office blocks for every authorized provider so the calendar treats them as available.')
            ->addOption(
                'weeks',
                'w',
                InputOption::VALUE_REQUIRED,
                'How many weeks forward the recurring blocks should cover.',
                (string) self::DEFAULT_WEEKS
            )
            ->addOption(
                'force',
                'f',
                InputOption::VALUE_NONE,
                'Insert even if a current In Office block already exists for the provider.'
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $weeksOption = $input->getOption('weeks');
        $weeks = is_numeric($weeksOption) ? (int) $weeksOption : self::DEFAULT_WEEKS;
        if ($weeks < 1) {
            $io->error('--weeks must be a positive integer.');
            return Command::FAILURE;
        }
        $force = (bool) $input->getOption('force');

        $providers = $this->loadProviderIds();
        if ($providers === []) {
            $io->error('No active providers found. Restore the baseline first.');
            return Command::FAILURE;
        }

        $today = new \DateTimeImmutable('today');
        $endDate = $today->modify('+' . $weeks . ' weeks');

        $rows = [];
        $inserted = 0;
        $skipped = 0;

        foreach ($providers as $providerId) {
            if (!$force && $this->hasCurrentInOfficeBlock($providerId, $today)) {
                $rows[] = [(string) $providerId, '—', '—', 'already covered'];
                $skipped++;
                continue;
            }

            $this->insertAvailabilityBlock(
                $providerId,
                self::CAT_IN_OFFICE,
                'In Office',
                self::DAY_START,
                $today,
                $endDate,
            );
            $this->insertAvailabilityBlock(
                $providerId,
                self::CAT_OUT_OF_OFFICE,
                'Out Of Office',
                self::DAY_END,
                $today,
                $endDate,
            );
            $rows[] = [
                (string) $providerId,
                self::DAY_START,
                self::DAY_END,
                'inserted (weekly)',
            ];
            $inserted++;
        }

        $io->table(['provider', 'in_office', 'out_of_office', 'note'], $rows);
        $io->success(sprintf(
            '%d provider(s) covered through %s. (%d inserted, %d already covered)',
            $inserted + $skipped,
            $endDate->format('Y-m-d'),
            $inserted,
            $skipped,
        ));
        return Command::SUCCESS;
    }

    private function insertAvailabilityBlock(
        int $providerId,
        int $catId,
        string $title,
        string $startTime,
        \DateTimeImmutable $eventDate,
        \DateTimeImmutable $endDate,
    ): void {
        $uuid = (new UuidRegistry())->createUuid();
        $sql = "INSERT INTO openemr_postcalendar_events SET
            uuid = ?,
            pc_catid = ?,
            pc_aid = ?,
            pc_pid = '',
            pc_title = ?,
            pc_time = NOW(),
            pc_hometext = '',
            pc_eventDate = ?,
            pc_endDate = ?,
            pc_duration = 0,
            pc_recurrtype = 1,
            pc_recurrspec = ?,
            pc_recurrfreq = 0,
            pc_startTime = ?,
            pc_endTime = ?,
            pc_alldayevent = 0,
            pc_eventstatus = 1,
            pc_sharing = 1,
            pc_apptstatus = '-',
            pc_facility = 3,
            pc_billing_location = 3,
            pc_informant = ?,
            pc_topic = 1,
            pc_multiple = 0";

        QueryUtils::sqlStatementThrowException($sql, [
            $uuid,
            $catId,
            $providerId,
            $title,
            $eventDate->format('Y-m-d'),
            $endDate->format('Y-m-d'),
            serialize(self::RECUR_WEEKLY_SPEC),
            $startTime,
            $startTime, // baseline uses pc_endTime = pc_startTime; pc_duration=0 means "open until schedule_end"
            $providerId,
        ]);
    }

    private function hasCurrentInOfficeBlock(int $providerId, \DateTimeImmutable $today): bool
    {
        $value = QueryUtils::fetchSingleValue(
            "SELECT COUNT(*) AS n
             FROM openemr_postcalendar_events
             WHERE pc_aid = ?
               AND pc_catid = ?
               AND pc_recurrtype > 0
               AND pc_eventDate <= ?
               AND pc_endDate >= ?",
            'n',
            [$providerId, self::CAT_IN_OFFICE, $today->format('Y-m-d'), $today->format('Y-m-d')]
        );
        return is_numeric($value) && (int) $value > 0;
    }

    /**
     * @return list<int>
     */
    private function loadProviderIds(): array
    {
        $sql = "SELECT id FROM users WHERE authorized = 1 AND active = 1 AND id > 0 ORDER BY id";
        $rows = QueryUtils::fetchTableColumn($sql, 'id', []);
        $ids = [];
        foreach ($rows as $row) {
            if (is_numeric($row) && (int) $row > 0) {
                $ids[] = (int) $row;
            }
        }
        return $ids;
    }
}
