<?php

/**
 * §5.3 morning-prep precompute Console command.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Common\Command;

use DateInterval;
use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Cli\GuzzleBriefingHttpClient;
use OpenEMR\Modules\ClinicalCopilot\Cli\InWindowPredicate;
use OpenEMR\Modules\ClinicalCopilot\Cli\PrecomputeOrchestrator;
use OpenEMR\Modules\ClinicalCopilot\Cli\PrecomputeRunner;
use OpenEMR\Modules\ClinicalCopilot\Cli\RandomRequestIdGenerator;
use OpenEMR\Modules\ClinicalCopilot\Cli\RunOptions;
use OpenEMR\Modules\ClinicalCopilot\Cli\SettingsRepositoryProvider;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDbalConnection;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production\ScheduleServiceDataSource;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleAdapter;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Drives the §5.3 morning-prep precompute against the agent service.
 *
 * Cron contract: invoke once per tick (default hourly). The
 * orchestrator filters to opted-in practitioners whose local prep
 * time falls inside the last `--window-minutes`. Practitioners who
 * are not opted in are filtered out at the SQL boundary in
 * `SettingsRepository::findEnabledPractitioners()`, so the
 * default-disabled cost story holds: zero rows read from the
 * settings table = zero work, zero log lines, zero tokens.
 *
 * Exit codes:
 *   - 0 (`SUCCESS`) for empty runs and partial successes.
 *   - 1 (`FAILURE`) only when every attempted slot errored.
 */
class AgentPrecomputeDayCommand extends Command
{
    public const DEFAULT_WINDOW_MINUTES = 60;

    /**
     * Optional override for the orchestrator constructor — exposed for
     * tests via `CommandTester`. Production resolves to the in-process
     * factory below.
     *
     * @var (callable(InputInterface, OutputInterface): PrecomputeRunner)|null
     */
    private $runnerFactory;

    /**
     * @param (callable(InputInterface, OutputInterface): PrecomputeRunner)|null $runnerFactory
     */
    public function __construct(?callable $runnerFactory = null)
    {
        parent::__construct();
        $this->runnerFactory = $runnerFactory;
    }

    protected function configure(): void
    {
        $this
            ->setName('agent:precompute-day')
            ->setDescription('Pre-compute UC1 briefings for opted-in practitioners whose morning-prep time falls in the current cron window.')
            ->addOption(
                'window-minutes',
                null,
                InputOption::VALUE_REQUIRED,
                'How many minutes a cron tick covers; the predicate fires when local prep time landed in [now, now+window).',
                (string) self::DEFAULT_WINDOW_MINUTES,
            )
            ->addOption(
                'practitioner',
                null,
                InputOption::VALUE_REQUIRED,
                'Restrict the run to a single practitioner uuid (debug).',
            )
            ->addOption(
                'force',
                null,
                InputOption::VALUE_NONE,
                'Hard overwrite: bypass the per-(practitioner, appointment, day) idempotency check.',
            )
            ->addOption(
                'dry-run',
                null,
                InputOption::VALUE_NONE,
                'Loop the in-window practitioner set and log decisions, but do not POST to the agent.',
            )
            ->addOption(
                'now',
                null,
                InputOption::VALUE_REQUIRED,
                'Override the current instant for the run (any format DateTimeImmutable accepts, e.g. "2026-05-04T07:30:00"). Useful for testing/demos against a future or past day.',
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $windowMinutesRaw = $input->getOption('window-minutes');
        $windowMinutes = is_numeric($windowMinutesRaw) ? (int) $windowMinutesRaw : self::DEFAULT_WINDOW_MINUTES;
        if ($windowMinutes <= 0) {
            $io->error('--window-minutes must be a positive integer');
            return Command::INVALID;
        }
        $practitionerRaw = $input->getOption('practitioner');
        $practitioner = is_string($practitionerRaw) && $practitionerRaw !== '' ? $practitionerRaw : null;
        $force = (bool) $input->getOption('force');
        $dryRun = (bool) $input->getOption('dry-run');

        $nowRaw = $input->getOption('now');
        if (is_string($nowRaw) && $nowRaw !== '') {
            try {
                $now = new DateTimeImmutable($nowRaw);
            } catch (\DateMalformedStringException) {
                $io->error('--now must be a valid datetime string (e.g. "2026-05-04T07:30:00")');
                return Command::INVALID;
            }
        } else {
            $now = new DateTimeImmutable();
        }

        $options = new RunOptions(
            window: new DateInterval('PT' . (string) $windowMinutes . 'M'),
            force: $force,
            practitionerUuid: $practitioner,
            dryRun: $dryRun,
        );

        try {
            $runner = ($this->runnerFactory ?? self::productionRunnerFactory(...))($input, $output);
        } catch (\RuntimeException $e) {
            // Production factory throws \RuntimeException for missing
            // env vars (`AGENT_BASE_URL`, etc.) — that's the only
            // expected failure during construction. Anything else is a
            // genuine bug and should propagate.
            $io->error('Failed to construct precompute orchestrator: ' . $e->getMessage());
            return Command::FAILURE;
        }

        $summary = $runner->runForWindow($now, $options);

        $io->section('Precompute summary');
        $io->table(
            ['metric', 'value'],
            array_map(
                static fn(string $k, int $v): array => [$k, (string) $v],
                array_keys($summary->toLogContext()),
                array_values($summary->toLogContext()),
            ),
        );

        return $summary->isFullDayFailure() ? Command::FAILURE : Command::SUCCESS;
    }

    /**
     * Production wiring. Reads OpenEMR's environment for the agent
     * URL, FHIR base, and issuer. Constructs the orchestrator with
     * the real Settings repo (DBAL connection), Schedule adapter
     * (production data source), Guzzle HTTP client, and the in-process
     * AgentTokenMinter.
     */
    private static function productionRunnerFactory(
        InputInterface $input,
        OutputInterface $output,
    ): PrecomputeRunner {
        $settingsRepo = new SettingsRepository(AgentDbalConnection::get());
        $logger = self::resolveLogger();

        $agentBaseUrl = self::requiredEnv('AGENT_BASE_URL');
        $issuer = self::requiredEnv('AGENT_JWT_ISSUER');
        $fhirBaseUrl = self::requiredEnv('AGENT_FHIR_BASE_URL');
        $siteId = self::optionalEnv('OE_SITE_ID', 'default');

        return new PrecomputeOrchestrator(
            settings: new SettingsRepositoryProvider($settingsRepo),
            inWindow: new InWindowPredicate(),
            scheduleAdapter: new ScheduleAdapter(new ScheduleServiceDataSource()),
            tokenMinter: AgentTokenMinter::fromOpenEmr(),
            policyGate: new PolicyGate(),
            http: new GuzzleBriefingHttpClient(),
            logger: $logger,
            requestIds: new RandomRequestIdGenerator(),
            agentBaseUrl: $agentBaseUrl,
            issuer: $issuer,
            fhirBaseUrl: $fhirBaseUrl,
            siteId: $siteId,
        );
    }

    private static function resolveLogger(): LoggerInterface
    {
        return new NullLogger();
    }

    private static function requiredEnv(string $name): string
    {
        $value = self::optionalEnv($name, '');
        if ($value === '') {
            throw new \RuntimeException($name . ' is not set in the environment');
        }
        return $value;
    }

    private static function optionalEnv(string $name, string $default): string
    {
        $fromEnv = $_ENV[$name] ?? null;
        if (is_string($fromEnv) && $fromEnv !== '') {
            return $fromEnv;
        }
        $fromGetenv = getenv($name);
        if (is_string($fromGetenv) && $fromGetenv !== '') {
            return $fromGetenv;
        }
        return $default;
    }
}
