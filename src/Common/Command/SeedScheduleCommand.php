<?php

/**
 * SeedScheduleCommand populates openemr_postcalendar_events with realistic
 * provider schedules — one back-fill day plus N business days into the
 * future. UC1's "today's reason for visit" briefing and UC5's morning-prep
 * view both depend on having appointments on the calendar; without this
 * command, every demo requires manually creating them in the UI.
 *
 * Slots are 30-minute, 8:00–17:00 with a noon hour skipped. Each provider
 * gets up to --per-provider-per-day visits per business day. Patients are
 * sampled from the existing patient_data table, biased so a patient on the
 * provider's panel (patient_data.providerID matches) is more likely to be
 * seen by their PCP — but partner-coverage swaps still happen ~30% of the
 * time, matching the Riverside Family Health workflow USERS.md describes.
 *
 * Past appointments get a check-out / no-show status mix; future
 * appointments stay '-' (default).
 *
 * Pure-additive: re-running stacks more events (use distinct dates if you
 * want non-overlapping data). Restore baseline to start over.
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
use OpenEMR\Seed\FixturePatient;
use OpenEMR\Seed\Generators\AppointmentGenerator;
use OpenEMR\Seed\Generators\VisitReasonPicker;
use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Services\AppointmentService;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

class SeedScheduleCommand extends Command
{
    private const DEFAULT_DAYS = 10;
    private const DEFAULT_PER_PROVIDER_PER_DAY = 18;
    private const DEFAULT_PCP_USERNAME = 'physician';

    /**
     * How many weeks forward to seed the per-fixture-patient weekly
     * recurrence. 12 weeks (~3 months) keeps every fixture patient
     * visible on the calendar for the whole demo window without
     * ballooning past `seed:availability`'s default 26-week horizon.
     */
    private const DEFAULT_FIXTURE_WEEKS = 12;

    /** Anchor slot for the weekly fixture appointments. */
    private const FIXTURE_APPT_TIME = '10:00:00';

    /** Probability (out of 100) that a patient is paired with a non-PCP provider for a given visit. */
    private const COVERAGE_SWAP_PERCENT = 30;

    /** Time slots per day, 8:00 through 16:30 with a 12:00 lunch skip. */
    private const TIME_SLOTS = [
        '08:00:00', '08:30:00', '09:00:00', '09:30:00',
        '10:00:00', '10:30:00', '11:00:00', '11:30:00',
        '13:00:00', '13:30:00', '14:00:00', '14:30:00',
        '15:00:00', '15:30:00', '16:00:00', '16:30:00',
        '17:00:00', '17:30:00',
    ];

    /** Status mix for completed / past appointments. */
    private const PAST_STATUS_MIX = [
        '>' => 80, // Checked out
        '?' => 7,  // No show
        'x' => 8,  // Canceled
        '%' => 5,  // Canceled <24h
    ];

    protected function configure(): void
    {
        $this
            ->setName('seed:schedule')
            ->setDescription('Populate calendar with appointments for today + N business days, plus 1 backfill day.')
            ->addOption('days', 'd', InputOption::VALUE_REQUIRED, 'Business days into the future to schedule.', (string) self::DEFAULT_DAYS)
            ->addOption('per-provider-per-day', 'p', InputOption::VALUE_REQUIRED, 'Appointments per provider per day.', (string) self::DEFAULT_PER_PROVIDER_PER_DAY)
            ->addOption('fixture-weeks', null, InputOption::VALUE_REQUIRED, 'Weeks forward to seed one weekly appointment per fixture patient.', (string) self::DEFAULT_FIXTURE_WEEKS)
            ->addOption('seed', null, InputOption::VALUE_REQUIRED, 'Optional integer Faker seed for deterministic output.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $days = $this->intOption($input, 'days', self::DEFAULT_DAYS);
        $perDay = $this->intOption($input, 'per-provider-per-day', self::DEFAULT_PER_PROVIDER_PER_DAY);
        if ($days < 1 || $perDay < 1) {
            $io->error('--days and --per-provider-per-day must both be positive integers.');
            return Command::FAILURE;
        }
        if ($perDay > count(self::TIME_SLOTS)) {
            $io->error('--per-provider-per-day cannot exceed ' . count(self::TIME_SLOTS) . ' (number of available slots).');
            return Command::FAILURE;
        }

        $faker = FakerFactory::create('en_US');
        $seedOption = $input->getOption('seed');
        if (is_numeric($seedOption)) {
            $faker->seed((int) $seedOption);
        }

        $providers = $this->loadProviderIds();
        if ($providers === []) {
            $io->error('No active provider users found. Restore the baseline first.');
            return Command::FAILURE;
        }
        $defaultPcpId = $this->loadDefaultPcpId() ?? $providers[0];

        $patients = $this->loadPatients();
        if ($patients === []) {
            $io->error('No patients found. Run seed:patients first.');
            return Command::FAILURE;
        }

        // AppointmentService reads authUserID from session for pc_informant.
        SessionUtil::setSession('authUserID', $defaultPcpId);

        $reasonPicker = new VisitReasonPicker($faker);
        $generator = new AppointmentGenerator($reasonPicker);
        $service = new AppointmentService();

        $businessDays = $this->businessDayRange($days);
        $totalSlots = count($businessDays) * count($providers) * $perDay;

        $io->section(sprintf(
            'Scheduling up to %d slots across %d business days × %d provider(s) × %d slots/day',
            $totalSlots,
            count($businessDays),
            count($providers),
            $perDay,
        ));
        $io->progressStart($totalSlots);

        $stats = ['inserted' => 0, 'failed' => 0, 'past' => 0, 'future' => 0];
        $today = new \DateTimeImmutable('today');
        $start = microtime(true);

        // Group patients by PCP so we can pick the provider's panel first.
        $patientsByPcp = [];
        foreach ($patients as $patient) {
            $patientsByPcp[$patient['providerID']][] = $patient;
        }

        foreach ($businessDays as $date) {
            $isPast = $date < $today;
            foreach ($providers as $providerId) {
                $slots = (array) array_rand(self::TIME_SLOTS, $perDay);
                $slots = array_map(fn(int $idx): string => self::TIME_SLOTS[$idx], $slots);
                sort($slots);

                foreach ($slots as $slot) {
                    $patient = $this->pickPatientForProvider($patientsByPcp, $patients, $providerId, $faker);
                    if ($patient === null) {
                        $io->progressAdvance();
                        continue;
                    }
                    $apptStatus = $isPast ? $this->pickPastStatus($faker) : '-';

                    $payload = $generator->generate(
                        PatientArchetype::tryFrom($patient['archetype']) ?? PatientArchetype::HealthyAdult,
                        $providerId,
                        $date->format('Y-m-d'),
                        $slot,
                        $apptStatus,
                    );

                    try {
                        $insertId = $service->insert($patient['pid'], $payload);
                        if ($insertId) {
                            $stats['inserted']++;
                            if ($isPast) {
                                $stats['past']++;
                            } else {
                                $stats['future']++;
                            }
                        } else {
                            $stats['failed']++;
                        }
                    } catch (\RuntimeException | \InvalidArgumentException) {
                        $stats['failed']++;
                    }
                    $io->progressAdvance();
                }
            }
        }

        $io->progressFinish();

        // Fixture patients: one appointment per week, on the default
        // PCP, anchored to a fixed slot. This keeps each fixture
        // patient (Chen/Whitaker/Reyes/Kowalski) visible on the
        // upcoming calendar so the demo can pull up their chart from
        // the morning-prep view without first scrolling past three
        // months of randomly-rolled patients.
        $fixtureWeeks = $this->intOption($input, 'fixture-weeks', self::DEFAULT_FIXTURE_WEEKS);
        $stats['fixture_appts'] = 0;
        $stats['fixture_missing'] = 0;
        if ($fixtureWeeks > 0) {
            $io->section("Fixture-patient weekly recurrence ({$fixtureWeeks} weeks × " . count(FixturePatient::cases()) . ' patient(s))');
            foreach (FixturePatient::cases() as $fixture) {
                $pid = $this->lookupFixturePid($fixture);
                if ($pid === null) {
                    $stats['fixture_missing']++;
                    $io->warning("Fixture patient {$fixture->value} not found in patient_data — run seed:patients first.");
                    continue;
                }
                $apptDate = $this->nextBusinessDay(new \DateTimeImmutable('today'));
                for ($w = 0; $w < $fixtureWeeks; $w++) {
                    $payload = $generator->generate(
                        $fixture->archetype(),
                        $defaultPcpId,
                        $apptDate->format('Y-m-d'),
                        self::FIXTURE_APPT_TIME,
                        '-',
                    );
                    try {
                        $insertId = $service->insert($pid, $payload);
                        if ($insertId) {
                            $stats['fixture_appts']++;
                            $stats['inserted']++;
                            $stats['future']++;
                        } else {
                            $stats['failed']++;
                        }
                    } catch (\RuntimeException | \InvalidArgumentException) {
                        $stats['failed']++;
                    }
                    $apptDate = $this->nextBusinessDay($apptDate->modify('+7 days'));
                }
            }
        }

        $elapsed = round(microtime(true) - $start, 1);

        $io->table(['metric', 'count'], [
            ['business days scheduled', count($businessDays)],
            ['providers', count($providers)],
            ['appointments inserted', $stats['inserted']],
            ['  past', $stats['past']],
            ['  future', $stats['future']],
            ['  fixture-weekly', $stats['fixture_appts']],
            ['fixture patients missing', $stats['fixture_missing']],
            ['failures', $stats['failed']],
        ]);
        $io->success("Done in {$elapsed}s.");
        return $stats['failed'] === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    /**
     * Walk forward from `$from` (inclusive) to the next non-weekend
     * date. Used so the weekly fixture-appointment series never lands
     * on a Saturday/Sunday — providers don't have availability blocks
     * on weekends so the appointment would be unbookable.
     */
    private function nextBusinessDay(\DateTimeImmutable $from): \DateTimeImmutable
    {
        $cursor = $from;
        while ($this->isWeekend($cursor)) {
            $cursor = $cursor->modify('+1 day');
        }
        return $cursor;
    }

    private function lookupFixturePid(FixturePatient $fixture): ?int
    {
        $row = QueryUtils::fetchSingleValue(
            'SELECT pid FROM patient_data WHERE lname = ? AND DOB = ? LIMIT 1',
            'pid',
            [$fixture->lastName(), $fixture->dateOfBirth()]
        );
        return is_numeric($row) && (int) $row > 0 ? (int) $row : null;
    }

    /**
     * Date range covering yesterday (1 backfill business day) through $futureDays
     * business days into the future.
     *
     * @return list<\DateTimeImmutable>
     */
    private function businessDayRange(int $futureDays): array
    {
        $days = [];
        $cursor = new \DateTimeImmutable('today');
        // Walk back to yesterday's business day for the backfill.
        $back = $cursor->modify('-1 day');
        while ($this->isWeekend($back)) {
            $back = $back->modify('-1 day');
        }
        $days[] = $back;
        $days[] = $cursor->modify('today');
        // If today is a weekend, drop it.
        if ($this->isWeekend($days[1])) {
            array_pop($days);
        }
        // Walk forward.
        $added = 0;
        $forward = $cursor->modify('+1 day');
        while ($added < $futureDays) {
            if (!$this->isWeekend($forward)) {
                $days[] = $forward;
                $added++;
            }
            $forward = $forward->modify('+1 day');
        }
        return $days;
    }

    private function isWeekend(\DateTimeImmutable $d): bool
    {
        $dow = (int) $d->format('N');
        return $dow >= 6;
    }

    /**
     * @param array<int, list<array{pid: int, providerID: int, archetype: string}>> $byPcp
     * @param list<array{pid: int, providerID: int, archetype: string}> $all
     * @return array{pid: int, providerID: int, archetype: string}|null
     */
    private function pickPatientForProvider(array $byPcp, array $all, int $providerId, Faker $faker): ?array
    {
        $swapToCoverage = $faker->numberBetween(1, 100) <= self::COVERAGE_SWAP_PERCENT;
        if (!$swapToCoverage && isset($byPcp[$providerId]) && $byPcp[$providerId] !== []) {
            return $byPcp[$providerId][array_rand($byPcp[$providerId])];
        }
        return $all === [] ? null : $all[array_rand($all)];
    }

    private function pickPastStatus(Faker $faker): string
    {
        $total = array_sum(self::PAST_STATUS_MIX);
        $roll = $faker->numberBetween(1, $total);
        $cumulative = 0;
        foreach (self::PAST_STATUS_MIX as $status => $weight) {
            $cumulative += $weight;
            if ($roll <= $cumulative) {
                return $status;
            }
        }
        return '-';
    }

    /**
     * Patients with synthetic 'archetype' field. Since the column doesn't
     * exist on patient_data, we infer archetype from the patient's recorded
     * problems — close enough for picking an appropriate visit reason.
     *
     * @return list<array{pid: int, providerID: int, archetype: string}>
     */
    private function loadPatients(): array
    {
        $sql = "
            SELECT pd.pid, pd.providerID,
                CASE
                    WHEN EXISTS (SELECT 1 FROM lists l WHERE l.pid=pd.pid AND l.diagnosis='ICD10:E11.9' AND l.activity=1) THEN 'diabetic'
                    WHEN EXISTS (SELECT 1 FROM lists l WHERE l.pid=pd.pid AND l.diagnosis='ICD10:I10' AND l.activity=1)   THEN 'hypertensive'
                    WHEN (SELECT COUNT(*) FROM lists l WHERE l.pid=pd.pid AND l.type='medical_problem' AND l.activity=1) >= 3 THEN 'complex_elderly'
                    ELSE 'healthy_adult'
                END AS archetype
            FROM patient_data pd
            WHERE pd.pid > 0
        ";
        $rows = QueryUtils::fetchRecords($sql, []);
        $out = [];
        foreach ($rows as $row) {
            $rawPid = $row['pid'] ?? null;
            $rawProvider = $row['providerID'] ?? null;
            $rawArchetype = $row['archetype'] ?? null;
            if (!is_numeric($rawPid)) {
                continue;
            }
            $out[] = [
                'pid'        => (int) $rawPid,
                'providerID' => is_numeric($rawProvider) ? (int) $rawProvider : 0,
                'archetype'  => is_string($rawArchetype) ? $rawArchetype : 'healthy_adult',
            ];
        }
        return $out;
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

    private function intOption(InputInterface $input, string $name, int $default): int
    {
        $val = $input->getOption($name);
        return is_numeric($val) ? (int) $val : $default;
    }
}
