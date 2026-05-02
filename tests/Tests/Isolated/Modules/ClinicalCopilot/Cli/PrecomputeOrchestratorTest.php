<?php

/**
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
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\JtiGenerator;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Cli\BriefingHttpClient;
use OpenEMR\Modules\ClinicalCopilot\Cli\BriefingHttpException;
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

final class PrecomputeOrchestratorTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot';

    private const FIXED_NOW_UTC = '2026-01-15T13:55:00+00:00';

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

    public function testEmptyEnabledSetProducesEmptySummaryAndZeroLogLines(): void
    {
        $logger = new RecordingLogger();
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([]),
            scheduleRows: [],
            http: new RecordingHttpClient(['inserted']),
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(0, $summary->practitionersConsidered);
        $this->assertSame(0, $summary->practitionersInWindow);
        $this->assertSame(0, $summary->slotsAttempted);
        // Only the run-complete summary line — never a per-practitioner skip line.
        $this->assertCount(1, $logger->records);
        $this->assertSame('precompute: run complete', $logger->records[0]['message']);
    }

    public function testOutOfWindowPractitionerIsSkippedSilently(): void
    {
        // 14:55 UTC, January = CST = 08:55 local. 07:50 local + 1h
        // window ends at 08:50, so this is past the window.
        $now = new DateTimeImmutable('2026-01-15T14:55:00+00:00');
        $logger = new RecordingLogger();
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
            ]),
            scheduleRows: [],
            http: new RecordingHttpClient([]),
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            $now,
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(1, $summary->practitionersConsidered);
        $this->assertSame(0, $summary->practitionersInWindow);
        $this->assertSame(0, $summary->slotsAttempted);
    }

    public function testInWindowPractitionerWithEmptyScheduleLogsAndContinues(): void
    {
        $logger = new RecordingLogger();
        $http = new RecordingHttpClient([]);
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
            ]),
            scheduleRows: [],
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(1, $summary->practitionersInWindow);
        $this->assertSame(0, $summary->slotsAttempted);
        $this->assertCount(0, $http->calls);
    }

    public function testInWindowPractitionerLoopsSlotsAndAggregatesOutcomes(): void
    {
        $logger = new RecordingLogger();
        $http = new RecordingHttpClient(['inserted', 'skipped_idempotent']);
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
            ]),
            scheduleRows: [
                $this->slotRow('apt-1', 42, '2026-01-15', '08:00:00'),
                $this->slotRow('apt-2', 43, '2026-01-15', '09:00:00'),
            ],
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(2, $summary->slotsAttempted);
        $this->assertSame(1, $summary->slotsWritten);
        $this->assertSame(1, $summary->slotsSkippedIdempotent);
        $this->assertSame(0, $summary->slotsErrored);
        $this->assertCount(2, $http->calls);
        $firstCall = $http->calls[0];
        $this->assertSame('apt-1', $firstCall['envelope']['appointmentId']);
        $this->assertTrue($firstCall['envelope']['precompute']);
        $this->assertFalse($firstCall['envelope']['force']);
        $this->assertSame('11111111-1111-1111-1111-111111111111', $firstCall['envelope']['practitionerUuid']);
    }

    public function testHttpFailureForOneSlotIncrementsErroredAndContinues(): void
    {
        $logger = new RecordingLogger();
        $http = new RecordingHttpClient([
            'inserted',
            new BriefingHttpException('upstream 500', 500, 'briefing_failed'),
            'inserted',
        ]);
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
            ]),
            scheduleRows: [
                $this->slotRow('apt-1', 42, '2026-01-15', '08:00:00'),
                $this->slotRow('apt-2', 43, '2026-01-15', '09:00:00'),
                $this->slotRow('apt-3', 44, '2026-01-15', '10:00:00'),
            ],
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H')),
        );
        $this->assertSame(3, $summary->slotsAttempted);
        $this->assertSame(2, $summary->slotsWritten);
        $this->assertSame(1, $summary->slotsErrored);
        $this->assertFalse($summary->isFullDayFailure());
    }

    public function testForceFlagIsForwardedToTheAgent(): void
    {
        $logger = new RecordingLogger();
        $http = new RecordingHttpClient(['overwritten']);
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
            ]),
            scheduleRows: [
                $this->slotRow('apt-1', 42, '2026-01-15', '08:00:00'),
            ],
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H'), force: true),
        );
        $this->assertSame(1, $summary->slotsOverwritten);
        $this->assertTrue($http->calls[0]['envelope']['force']);
    }

    public function testDryRunDoesNotPostAnyRequests(): void
    {
        $logger = new RecordingLogger();
        $http = new RecordingHttpClient([]);
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
            ]),
            scheduleRows: [
                $this->slotRow('apt-1', 42, '2026-01-15', '08:00:00'),
            ],
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(window: new DateInterval('PT1H'), dryRun: true),
        );
        $this->assertSame(1, $summary->slotsAttempted);
        $this->assertSame(0, $summary->slotsWritten);
        $this->assertCount(0, $http->calls);
    }

    public function testPractitionerFilterRestrictsToOnePractitioner(): void
    {
        $logger = new RecordingLogger();
        $http = new RecordingHttpClient(['inserted']);
        $orchestrator = $this->buildOrchestrator(
            settings: new InMemoryPractitionerProvider([
                $this->practitionerSettings('11111111-1111-1111-1111-111111111111'),
                $this->practitionerSettings('22222222-2222-2222-2222-222222222222'),
            ]),
            scheduleRows: [$this->slotRow('apt-1', 42, '2026-01-15', '08:00:00')],
            http: $http,
            logger: $logger,
        );
        $summary = $orchestrator->runForWindow(
            new DateTimeImmutable(self::FIXED_NOW_UTC),
            new RunOptions(
                window: new DateInterval('PT1H'),
                practitionerUuid: '11111111-1111-1111-1111-111111111111',
            ),
        );
        $this->assertSame(1, $summary->practitionersConsidered);
        $this->assertSame(1, $summary->practitionersInWindow);
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
     * @return array<string, mixed>
     */
    private function slotRow(string $apptId, int $pid, string $date, string $time): array
    {
        return [
            'pc_eid' => $apptId,
            'pc_pid' => $pid,
            'pc_eventDate' => $date,
            'pc_startTime' => $time,
            'pc_duration' => 900,
            'pc_catname' => 'Office Visit',
            'pc_title' => 'Follow-up',
        ];
    }

    /**
     * @param list<array<string, mixed>> $scheduleRows
     */
    private function buildOrchestrator(
        PractitionerProvider $settings,
        array $scheduleRows,
        BriefingHttpClient $http,
        RecordingLogger $logger,
    ): PrecomputeOrchestrator {
        $minter = new AgentTokenMinter(
            signingKey: new AgentSigningKey(
                self::keypair()['private'],
                self::keypair()['public'],
                null,
            ),
            clock: new TestFixedClock(new DateTimeImmutable(self::FIXED_NOW_UTC)),
            jtiGenerator: new TestFixedJtiGenerator('jti-fixture'),
        );
        return new PrecomputeOrchestrator(
            settings: $settings,
            inWindow: new InWindowPredicate(),
            scheduleAdapter: new ScheduleAdapter(new InMemoryScheduleDataSource($scheduleRows)),
            tokenMinter: $minter,
            policyGate: new PolicyGate(),
            http: $http,
            logger: $logger,
            requestIds: new SequentialRequestIdGenerator(),
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
            self::fail('openssl_pkey_new returned false — cannot run orchestrator tests');
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
}

final readonly class TestFixedClock implements ClockInterface
{
    public function __construct(private DateTimeImmutable $now)
    {
    }

    public function now(): DateTimeImmutable
    {
        return $this->now;
    }
}

final readonly class TestFixedJtiGenerator implements JtiGenerator
{
    public function __construct(private string $jti)
    {
    }

    public function generate(): string
    {
        return $this->jti;
    }
}

final readonly class InMemoryPractitionerProvider implements PractitionerProvider
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

final readonly class InMemoryScheduleDataSource implements ScheduleDataSource
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

final class SequentialRequestIdGenerator implements RequestIdGenerator
{
    private int $counter = 0;

    public function generate(): string
    {
        $this->counter += 1;
        return 'precompute-' . $this->counter;
    }
}

final class RecordingHttpClient implements BriefingHttpClient
{
    /** @var list<array{url: string, token: string, envelope: array<string, mixed>}> */
    public array $calls = [];

    /**
     * @param list<BriefingHttpOutcome|BriefingHttpException|string> $programmedResponses
     */
    public function __construct(private array $programmedResponses)
    {
    }

    public function postBriefing(string $url, string $bearerToken, array $envelope): BriefingHttpOutcome
    {
        $this->calls[] = ['url' => $url, 'token' => $bearerToken, 'envelope' => $envelope];
        if (count($this->programmedResponses) === 0) {
            throw new \LogicException('RecordingHttpClient ran out of programmed responses');
        }
        $response = array_shift($this->programmedResponses);
        if ($response instanceof BriefingHttpException) {
            throw $response;
        }
        if ($response instanceof BriefingHttpOutcome) {
            return $response;
        }
        $appointmentId = is_string($envelope['appointmentId']) ? $envelope['appointmentId'] : '';
        return new BriefingHttpOutcome(
            done: true,
            precomputeOutcome: $response,
            appointmentId: $appointmentId,
        );
    }
}

final class RecordingLogger extends AbstractLogger
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
