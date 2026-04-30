<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\RequestLog;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosedEvent;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosureListener;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\DisclosureRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\InMemoryDisclosureRecorder;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;
use Stringable;
use Symfony\Component\EventDispatcher\EventDispatcher;

final class RecordingLogger extends AbstractLogger
{
    /** @var list<array{level: string, message: string, context: array<mixed>}> */
    public array $entries = [];

    /**
     * @param array<mixed> $context
     */
    public function log(mixed $level, string|Stringable $message, array $context = []): void
    {
        $this->entries[] = [
            'level' => is_string($level) ? $level : 'unknown',
            'message' => (string) $message,
            'context' => $context,
        ];
    }
}

final class AgentDisclosureListenerTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/RequestLog';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/AgentDisclosure.php';
        require_once self::MODULE_DIR . '/AgentDisclosedEvent.php';
        require_once self::MODULE_DIR . '/AgentRequestLogRecorder.php';
        require_once self::MODULE_DIR . '/DisclosureRecorder.php';
        require_once self::MODULE_DIR . '/InMemoryAgentRequestLogRecorder.php';
        require_once self::MODULE_DIR . '/InMemoryDisclosureRecorder.php';
        require_once self::MODULE_DIR . '/AgentDisclosureListener.php';
    }

    public function testListenerInvokesBothRecorders(): void
    {
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $listener = new AgentDisclosureListener($disclosureSink, $requestLogSink, $this->logger());

        $event = new AgentDisclosedEvent($this->disclosure());
        $listener($event);

        self::assertCount(1, $disclosureSink->all(), 'extended_log recorder should receive the disclosure');
        self::assertCount(1, $requestLogSink->all(), 'agent_request_log recorder should receive the disclosure');
    }

    public function testDisclosureRecorderFailureDoesNotBlockRequestLog(): void
    {
        // Each sink is independent. A DBAL failure in extended_log must not
        // prevent agent_request_log from being written, and vice versa.
        $broken = new class implements DisclosureRecorder {
            public function record(AgentDisclosure $disclosure): never
            {
                throw new \RuntimeException('extended_log unavailable');
            }
        };
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $logger = new RecordingLogger();

        $listener = new AgentDisclosureListener($broken, $requestLogSink, $logger);
        $listener(new AgentDisclosedEvent($this->disclosure()));

        self::assertCount(1, $requestLogSink->all(), 'request log must still write when disclosure recorder fails');
        $errors = array_filter($logger->entries, static fn(array $e): bool => $e['level'] === 'error');
        self::assertCount(1, $errors);
        self::assertSame('extended_log', $errors[array_key_first($errors)]['context']['sink']);
    }

    public function testRequestLogRecorderFailureDoesNotBlockDisclosure(): void
    {
        $disclosureSink = new InMemoryDisclosureRecorder();
        $broken = new class implements AgentRequestLogRecorder {
            public function record(AgentDisclosure $disclosure): never
            {
                throw new \RuntimeException('agent_request_log unavailable');
            }
        };
        $logger = new RecordingLogger();

        $listener = new AgentDisclosureListener($disclosureSink, $broken, $logger);
        $listener(new AgentDisclosedEvent($this->disclosure()));

        self::assertCount(1, $disclosureSink->all(), 'disclosure must still write when request log fails');
        $errors = array_filter($logger->entries, static fn(array $e): bool => $e['level'] === 'error');
        self::assertCount(1, $errors);
        self::assertSame('agent_request_log', $errors[array_key_first($errors)]['context']['sink']);
    }

    public function testDisclosureRecorderDedupesPerActorPatientDay(): void
    {
        // The InMemoryDisclosureRecorder mirrors the production
        // ExtendedLogDisclosureRecorder dedup contract. Same (actor, patient,
        // day) → one row total, even after many requests.
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $listener = new AgentDisclosureListener($disclosureSink, $requestLogSink, $this->logger());

        $morning = new DateTimeImmutable('2026-04-30T08:00:00+00:00');
        $afternoon = new DateTimeImmutable('2026-04-30T15:00:00+00:00');
        $nextDay = new DateTimeImmutable('2026-05-01T08:00:00+00:00');

        $listener(new AgentDisclosedEvent($this->disclosure($morning, 'jti-1')));
        $listener(new AgentDisclosedEvent($this->disclosure($afternoon, 'jti-2')));
        $listener(new AgentDisclosedEvent($this->disclosure($nextDay, 'jti-3')));

        self::assertCount(2, $disclosureSink->all(), 'two distinct days → two extended_log rows');
        self::assertCount(3, $requestLogSink->all(), 'each request gets its own agent_request_log row');
    }

    public function testRegistersOnDispatcherUnderEventHandle(): void
    {
        $disclosureSink = new InMemoryDisclosureRecorder();
        $requestLogSink = new InMemoryAgentRequestLogRecorder();
        $listener = new AgentDisclosureListener($disclosureSink, $requestLogSink, $this->logger());

        $dispatcher = new EventDispatcher();
        $dispatcher->addListener(AgentDisclosedEvent::EVENT_HANDLE, $listener);

        $dispatcher->dispatch(new AgentDisclosedEvent($this->disclosure()), AgentDisclosedEvent::EVENT_HANDLE);

        self::assertCount(1, $disclosureSink->all());
        self::assertCount(1, $requestLogSink->all());
    }

    private function disclosure(?DateTimeImmutable $when = null, string $requestId = 'jti-abc'): AgentDisclosure
    {
        return new AgentDisclosure(
            disclosedAt: $when ?? new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
            actorUserId: 7,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/abc',
            siteId: 'default',
            patientPid: 42,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: $requestId,
            categories: ['allergy', 'medication'],
            destination: 'openemr-clinical-copilot-agent',
        );
    }

    private function logger(): LoggerInterface
    {
        return new \Psr\Log\NullLogger();
    }
}
