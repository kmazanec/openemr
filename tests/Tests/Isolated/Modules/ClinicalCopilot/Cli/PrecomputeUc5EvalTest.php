<?php

/**
 * §5.5 morning-prep evals at the orchestrator level.
 *
 * The Vitest cases under `agent/evals/cases/uc5/` cover what the
 * agent service itself can prove: per-slot flag content + the route's
 * idempotency short-circuit. This file covers what the agent service
 * cannot see — the PHP-side filter that decides which practitioners
 * even reach the agent in the first place. Two §5.5 cases live here:
 *
 *   - `testOptOutDayProducesZeroRowsAndZeroHttpCalls` (case 2):
 *     `findEnabledPractitioners()` returning an empty list means
 *     zero iterations, zero HTTP calls, zero log lines beyond the
 *     run-complete summary.
 *   - `testSettingsFlipPreventsRowsForFlippedPractitioner` (case 4):
 *     two opted-in practitioners; flipping one off between two
 *     orchestrator runs prevents that practitioner from being touched
 *     in the second run.
 *
 * A third method (`testTwentyPatientDayCountsByArchetype`) mirrors
 * the Vitest 20-patient case at the orchestrator level: 20 slots →
 * 20 POSTs, all carrying `precompute=true` and a distinct
 * `appointmentId`. Flag content stays in the Vitest layer because the
 * orchestrator never sees the agent's assistant message.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Cli;

use DateInterval;
use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentSigningKey;
use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface as ClinicalCopilotClock;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Cli\BriefingHttpClient;
use OpenEMR\Modules\ClinicalCopilot\Cli\BriefingHttpOutcome;
use OpenEMR\Modules\ClinicalCopilot\Cli\InWindowPredicate;
use OpenEMR\Modules\ClinicalCopilot\Cli\PractitionerProvider;
use OpenEMR\Modules\ClinicalCopilot\Cli\PrecomputeOrchestrator;
use OpenEMR\Modules\ClinicalCopilot\Cli\RequestIdGenerator;
use OpenEMR\Modules\ClinicalCopilot\Cli\RunOptions;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleDataSource;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Stringable;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/ClockInterface.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/JtiGenerator.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/BriefingHttpClient.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/PractitionerProvider.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Cli/RequestIdGenerator.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/Adapter/ScheduleDataSource.php';

final class PrecomputeUc5EvalTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot';

    /**
     * 14:55 UTC on a January day = 08:55 in America/Chicago, which sits
     * inside the [07:50, 08:50) one-hour window for a practitioner
     * configured with morning_prep_time_local=07:50. Same fixture the
     * existing PrecomputeOrchestratorTest uses; reusing it keeps the
     * windowing assertion stable across §5.3 and §5.5 evals.
     */
    private const FIXED_NOW_UTC = '2026-01-15T13:55:00+00:00';

    private const PRACTITIONER_A = '11111111-1111-1111-1111-111111111111';
    private const PRACTITIONER_B = '22222222-2222-2222-2222-222222222222';

    /** @var array{private: string, public: string}|null */
    private static ?array $keypair = null;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/src/Auth/AgentTokenMintException.php';
        require_once self::MODULE_DIR . '/src/Auth/AgentSigningKey.php';
        require_once self::MODULE_DIR . '/src/Auth/JwksKeyId.php';
        require_once self::MODULE_DIR . '/src/Auth/SystemClock.php';
        require_once self::MODULE_DIR . '/src/Auth/RandomJtiGenerator.php';
        require_once self::MODULE_DIR . '/src/Auth/ResolvedFhirUser.php';
        require_once self::MODULE_DIR . '/src/Auth/AgentTokenMinter.php';
        require_once self::MODULE_DIR . '/src/Auth/SessionContext.php';
        require_once self::MODULE_DIR . '/src/Auth/AgentRequest.php';
        require_once self::MODULE_DIR . '/src/Auth/PolicyDecision.php';
        require_once self::MODULE_DIR . '/src/Auth/PolicyDenyReason.php';
        require_once self::MODULE_DIR . '/src/Auth/PolicyGate.php';
        require_once self::MODULE_DIR . '/src/Settings/PractitionerSettings.php';
        require_once self::MODULE_DIR . '/src/Snapshot/Normalize.php';
        require_once self::MODULE_DIR . '/src/Snapshot/SourceReference.php';
        require_once self::MODULE_DIR . '/src/Snapshot/ScheduleSlot.php';
        require_once self::MODULE_DIR . '/src/Snapshot/Adapter/ScheduleAdapter.php';
        require_once self::MODULE_DIR . '/src/Cli/InWindowPredicate.php';
        require_once self::MODULE_DIR . '/src/Cli/RunOptions.php';
        require_once self::MODULE_DIR . '/src/Cli/RunSummary.php';
        require_once self::MODULE_DIR . '/src/Cli/BriefingHttpException.php';
        require_once self::MODULE_DIR . '/src/Cli/BriefingHttpOutcome.php';
        require_once self::MODULE_DIR . '/src/Cli/PrecomputeOrchestrator.php';

        if (self::$keypair === null) {
            self::$keypair = self::generateKeypair();
        }
    }

    public function testOptOutDayProducesZeroRowsAndZeroHttpCalls(): void
    {
        // §5.5 case 2: opted-out day. `findEnabledPractitioners()`
        // returns an empty list — the orchestrator never iterates,
        // never mints a token, never POSTs. Default-disabled cost
        // story holds: zero tokens, zero rows, zero log lines beyond
        // the per-run summary.
        $logger = new Uc5RecordingLogger();
        $http = new Uc5RecordingHttpClient([]);
        $orchestrator = $this->buildOrchestrator(
            settings: new Uc5InMemoryPractitionerProvider([]),
            scheduleRows: $this->dayPlan(),
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(0, $summary->practitionersConsidered);
        $this->assertSame(0, $summary->practitionersInWindow);
        $this->assertSame(0, $summary->slotsAttempted);
        $this->assertSame(0, $summary->slotsWritten);
        $this->assertCount(0, $http->calls);
        // Only the run-complete summary line — never a per-practitioner skip line.
        $this->assertCount(1, $logger->records);
        $this->assertSame('precompute: run complete', $logger->records[0]['message']);
    }

    public function testSettingsFlipPreventsRowsForFlippedPractitioner(): void
    {
        // §5.5 case 4: two opted-in practitioners. Run #1 produces
        // slots for both. Practitioner A flips morning_prep_enabled to
        // false; Run #2 produces slots only for B. The flip is
        // simulated by reconstructing the orchestrator with a provider
        // that omits A — same shape SettingsRepository would produce
        // after the toggle.
        $now = new DateTimeImmutable(self::FIXED_NOW_UTC);
        $window = new DateInterval('PT1H');
        $dayPlan = $this->dayPlan();

        // Run #1: both practitioners opted in, both fire.
        $http1 = new Uc5RecordingHttpClient(array_fill(0, count($dayPlan) * 2, 'inserted'));
        $orchestrator1 = $this->buildOrchestrator(
            settings: new Uc5InMemoryPractitionerProvider([
                $this->practitionerSettings(self::PRACTITIONER_A),
                $this->practitionerSettings(self::PRACTITIONER_B),
            ]),
            scheduleRows: $dayPlan,
            http: $http1,
            logger: new Uc5RecordingLogger(),
        );
        $summary1 = $orchestrator1->runForWindow($now, new RunOptions(window: $window));
        $this->assertSame(count($dayPlan) * 2, $summary1->slotsAttempted);
        $this->assertCount(count($dayPlan) * 2, $http1->calls);
        $practitionersInRun1 = array_unique(self::practitionerUuidsFromCalls($http1->calls));
        $this->assertEqualsCanonicalizing(
            [self::PRACTITIONER_A, self::PRACTITIONER_B],
            array_values($practitionersInRun1),
        );

        // Run #2: practitioner A flipped off. Provider reflects the new
        // state.
        $http2 = new Uc5RecordingHttpClient(array_fill(0, count($dayPlan), 'inserted'));
        $orchestrator2 = $this->buildOrchestrator(
            settings: new Uc5InMemoryPractitionerProvider([
                $this->practitionerSettings(self::PRACTITIONER_B),
            ]),
            scheduleRows: $dayPlan,
            http: $http2,
            logger: new Uc5RecordingLogger(),
        );
        $summary2 = $orchestrator2->runForWindow($now, new RunOptions(window: $window));
        $this->assertSame(count($dayPlan), $summary2->slotsAttempted);
        $this->assertCount(count($dayPlan), $http2->calls);
        $practitionersInRun2 = array_unique(self::practitionerUuidsFromCalls($http2->calls));
        $this->assertSame([self::PRACTITIONER_B], array_values($practitionersInRun2));
    }

    public function testTwentyPatientDayCountsByArchetype(): void
    {
        // §5.5 case 1 (PHP slice): the orchestrator POSTs once per
        // slot, all envelopes carry precompute=true and distinct
        // appointmentIds. Flag content lives in Vitest because the
        // orchestrator never sees the assistant message.
        $http = new Uc5RecordingHttpClient(array_fill(0, 20, 'inserted'));
        $orchestrator = $this->buildOrchestrator(
            settings: new Uc5InMemoryPractitionerProvider([
                $this->practitionerSettings(self::PRACTITIONER_A),
            ]),
            scheduleRows: $this->dayPlan(),
            http: $http,
            logger: new Uc5RecordingLogger(),
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(20, $summary->slotsAttempted);
        $this->assertSame(20, $summary->slotsWritten);
        $this->assertCount(20, $http->calls);

        $appointmentIds = self::envelopeFieldFromCalls($http->calls, 'appointmentId');
        $this->assertCount(20, array_unique($appointmentIds), 'each slot should have a distinct appointmentId');
        foreach ($http->calls as $call) {
            $this->assertTrue($call['envelope']['precompute']);
            $this->assertSame(self::PRACTITIONER_A, $call['envelope']['practitionerUuid']);
        }
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function dayPlan(): array
    {
        $rows = [];
        for ($i = 0; $i < 20; $i += 1) {
            $rows[] = [
                'pc_eid' => sprintf('apt-uc5-%02d', $i),
                'pc_pid' => 1000 + $i,
                'pc_eventDate' => '2026-01-15',
                'pc_startTime' => sprintf('%02d:%02d:00', 8 + intdiv($i * 30, 60), ($i * 30) % 60),
                'pc_duration' => 1800,
                'pc_catname' => 'Office Visit',
                'pc_title' => 'Slot ' . (string) $i,
            ];
        }
        return $rows;
    }

    private function practitionerSettings(string $uuid): PractitionerSettings
    {
        return new PractitionerSettings(
            practitionerUuid: $uuid,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
        );
    }

    /**
     * @param list<array<string, mixed>> $scheduleRows
     */
    private function buildOrchestrator(
        PractitionerProvider $settings,
        array $scheduleRows,
        BriefingHttpClient $http,
        Uc5RecordingLogger $logger,
    ): PrecomputeOrchestrator {
        $minter = new AgentTokenMinter(
            signingKey: new AgentSigningKey(
                self::keypair()['private'],
                self::keypair()['public'],
                null,
            ),
            clock: new Uc5FixedClock(new DateTimeImmutable(self::FIXED_NOW_UTC)),
            jtiGenerator: new Uc5FixedJtiGenerator('jti-uc5'),
        );
        return new PrecomputeOrchestrator(
            settings: $settings,
            inWindow: new InWindowPredicate(),
            scheduleAdapter: new ScheduleAdapter(new Uc5InMemoryScheduleDataSource($scheduleRows)),
            tokenMinter: $minter,
            policyGate: new PolicyGate(),
            http: $http,
            logger: $logger,
            requestIds: new Uc5SequentialRequestIdGenerator(),
            agentBaseUrl: 'http://agent.test',
            issuer: 'https://emr.example.test/oauth2/default',
            fhirBaseUrl: 'https://emr.example.test/apis/default/fhir',
            siteId: 'default',
        );
    }

    /**
     * @return array{private: string, public: string}
     */
    private static function keypair(): array
    {
        if (self::$keypair === null) {
            self::fail('keypair was not initialized in setUpBeforeClass');
        }
        return self::$keypair;
    }

    /**
     * @return array{private: string, public: string}
     */
    private static function generateKeypair(): array
    {
        $resource = openssl_pkey_new([
            'private_key_bits' => 2048,
            'private_key_type' => OPENSSL_KEYTYPE_RSA,
        ]);
        if ($resource === false) {
            self::fail('openssl_pkey_new returned false — cannot run UC5 eval tests');
        }
        $privatePem = '';
        openssl_pkey_export($resource, $privatePem);
        self::assertIsString($privatePem);
        $details = openssl_pkey_get_details($resource);
        self::assertNotFalse($details);
        $publicPem = $details['key'] ?? null;
        self::assertIsString($publicPem);
        return ['private' => $privatePem, 'public' => $publicPem];
    }

    /**
     * @param list<array{url: string, token: string, envelope: array<string, mixed>}> $calls
     * @return list<string>
     */
    private static function practitionerUuidsFromCalls(array $calls): array
    {
        return self::envelopeFieldFromCalls($calls, 'practitionerUuid');
    }

    /**
     * @param list<array{url: string, token: string, envelope: array<string, mixed>}> $calls
     * @return list<string>
     */
    private static function envelopeFieldFromCalls(array $calls, string $field): array
    {
        $out = [];
        foreach ($calls as $call) {
            $value = $call['envelope'][$field] ?? null;
            self::assertIsString($value, sprintf('envelope.%s must be a string', $field));
            $out[] = $value;
        }
        return $out;
    }
}

final readonly class Uc5FixedClock implements ClinicalCopilotClock
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class Uc5FixedJtiGenerator implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class Uc5InMemoryPractitionerProvider implements PractitionerProvider
{
    /**
     * @param list<PractitionerSettings> $rows
     */
    public function __construct(private array $rows)
    {
    }

    public function findEnabledPractitioners(): array
    {
        return $this->rows;
    }
}

final readonly class Uc5InMemoryScheduleDataSource implements ScheduleDataSource
{
    /**
     * @param list<array<string, mixed>> $rows
     */
    public function __construct(private array $rows)
    {
    }

    public function findScheduleByPractitioner(string $practitionerUuid, DateTimeImmutable $date): array
    {
        return $this->rows;
    }
}

final class Uc5SequentialRequestIdGenerator implements RequestIdGenerator
{
    private int $counter = 0;

    public function generate(): string
    {
        $this->counter += 1;
        return 'uc5-' . (string) $this->counter;
    }
}

final class Uc5RecordingHttpClient implements BriefingHttpClient
{
    /** @var list<array{url: string, token: string, envelope: array<string, mixed>}> */
    public array $calls = [];

    /**
     * @param list<string> $programmedOutcomes
     */
    public function __construct(private array $programmedOutcomes)
    {
    }

    public function postBriefing(string $url, string $bearerToken, array $envelope): BriefingHttpOutcome
    {
        $this->calls[] = ['url' => $url, 'token' => $bearerToken, 'envelope' => $envelope];
        if (count($this->programmedOutcomes) === 0) {
            throw new \LogicException('Uc5RecordingHttpClient ran out of programmed outcomes');
        }
        $outcome = array_shift($this->programmedOutcomes);
        $appointmentId = is_string($envelope['appointmentId']) ? $envelope['appointmentId'] : '';
        return new BriefingHttpOutcome(
            done: true,
            precomputeOutcome: $outcome,
            appointmentId: $appointmentId,
        );
    }
}

final class Uc5RecordingLogger extends AbstractLogger
{
    /** @var list<array{level: string, message: string, context: array<int|string, mixed>}> */
    public array $records = [];

    public function log($level, string|Stringable $message, array $context = []): void
    {
        $level = is_string($level) ? $level : 'unknown';
        $this->records[] = [
            'level' => $level,
            'message' => $message instanceof Stringable ? $message->__toString() : $message,
            'context' => $context,
        ];
    }
}
