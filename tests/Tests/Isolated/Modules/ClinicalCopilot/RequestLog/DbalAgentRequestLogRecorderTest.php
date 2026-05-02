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
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\AgentDisclosure;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\DbalAgentRequestLogRecorder;
use PHPUnit\Framework\TestCase;

final class DbalAgentRequestLogRecorderTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/RequestLog';

    private Connection $connection;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/AgentDisclosure.php';
        require_once self::MODULE_DIR . '/AgentRequestLogRecorder.php';
        require_once self::MODULE_DIR . '/DbalAgentRequestLogRecorder.php';
    }

    protected function setUp(): void
    {
        $this->connection = DriverManager::getConnection([
            'driver' => 'pdo_sqlite',
            'memory' => true,
        ]);

        // Schema mirrors the production migration's column shape. SQLite is
        // lenient on types, so the test value is in the column *names* — they
        // must match what DbalAgentRequestLogRecorder writes.
        $this->connection->executeStatement(<<<'SQL'
            CREATE TABLE agent_request_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                disclosed_at TEXT NOT NULL,
                actor_user_id INTEGER NOT NULL,
                actor_fhir_user TEXT NOT NULL,
                site_id TEXT NOT NULL,
                patient_pid INTEGER NOT NULL,
                patient_uuid TEXT NULL,
                conversation_id TEXT NULL,
                action TEXT NOT NULL,
                request_id TEXT NOT NULL UNIQUE,
                categories TEXT NOT NULL,
                destination TEXT NOT NULL
            )
        SQL);
    }

    public function testInsertsRowWithExpectedColumns(): void
    {
        $recorder = new DbalAgentRequestLogRecorder($this->connection);

        $d = new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
            actorUserId: 7,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/abc',
            siteId: 'default',
            patientPid: 42,
            patientUuid: '11111111-2222-3333-4444-555555555555',
            conversationId: 'conv-1',
            action: 'briefing',
            requestId: 'jti-deadbeef',
            categories: ['allergy', 'diagnosis', 'prescription'],
            destination: 'openemr-clinical-copilot-agent',
        );

        $recorder->record($d);

        $row = $this->connection->fetchAssociative('SELECT * FROM agent_request_log WHERE request_id = ?', ['jti-deadbeef']);
        self::assertIsArray($row);
        self::assertSame('2026-04-30 12:00:00', $row['disclosed_at']);
        self::assertEquals(7, $row['actor_user_id']);
        self::assertSame('https://emr.example/oauth2/default/Practitioner/abc', $row['actor_fhir_user']);
        self::assertSame('default', $row['site_id']);
        self::assertEquals(42, $row['patient_pid']);
        self::assertSame('11111111-2222-3333-4444-555555555555', $row['patient_uuid']);
        self::assertSame('conv-1', $row['conversation_id']);
        self::assertSame('briefing', $row['action']);
        self::assertSame('jti-deadbeef', $row['request_id']);
        self::assertIsString($row['categories']);
        self::assertSame(['allergy', 'diagnosis', 'prescription'], json_decode($row['categories'], true));
        self::assertSame('openemr-clinical-copilot-agent', $row['destination']);
    }

    public function testStoresNullPatientUuidAndConversationId(): void
    {
        $recorder = new DbalAgentRequestLogRecorder($this->connection);

        $recorder->record(new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T13:00:00+00:00'),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Person/u',
            siteId: 'default',
            patientPid: 99,
            patientUuid: null,
            conversationId: null,
            action: 'echo',
            requestId: 'jti-null-test',
            categories: [],
            destination: 'openemr-clinical-copilot-agent',
        ));

        $row = $this->connection->fetchAssociative('SELECT * FROM agent_request_log WHERE request_id = ?', ['jti-null-test']);
        self::assertIsArray($row);
        self::assertNull($row['patient_uuid']);
        self::assertNull($row['conversation_id']);
        self::assertIsString($row['categories']);
        self::assertSame([], json_decode($row['categories'], true));
    }

    public function testWritesOnlyToDeclaredColumns(): void
    {
        // Pin the column list. If a future contributor wants to add a
        // 'prompt' or 'completion' column, the test must be updated
        // deliberately — drift detection.
        $recorder = new DbalAgentRequestLogRecorder($this->connection);

        $recorder->record(new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T14:00:00+00:00'),
            actorUserId: 2,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/x',
            siteId: 'default',
            patientPid: 1,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: 'jti-cols',
            categories: ['lab'],
            destination: 'openemr-clinical-copilot-agent',
        ));

        $written = DbalAgentRequestLogRecorder::COLUMN_NAMES;
        sort($written);

        $expected = [
            'action',
            'actor_fhir_user',
            'actor_user_id',
            'categories',
            'conversation_id',
            'destination',
            'disclosed_at',
            'patient_pid',
            'patient_uuid',
            'request_id',
            'site_id',
        ];
        self::assertSame($expected, $written);

        // No prompt/completion-shaped columns
        foreach ($written as $col) {
            foreach (['prompt', 'completion', 'request_body', 'response_body', 'message', 'content', 'snapshot'] as $needle) {
                self::assertStringNotContainsStringIgnoringCase(
                    $needle,
                    $col,
                    "Recorder must not declare a column matching '{$needle}'",
                );
            }
        }
    }
}
