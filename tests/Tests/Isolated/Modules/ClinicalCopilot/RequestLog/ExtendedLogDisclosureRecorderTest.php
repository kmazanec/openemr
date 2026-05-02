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
use OpenEMR\Modules\ClinicalCopilot\RequestLog\ExtendedLogDisclosureRecorder;
use PHPUnit\Framework\TestCase;

final class ExtendedLogDisclosureRecorderTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/RequestLog';

    private Connection $connection;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/AgentDisclosure.php';
        require_once self::MODULE_DIR . '/DisclosureRecorder.php';
        require_once self::MODULE_DIR . '/ExtendedLogDisclosureRecorder.php';
    }

    protected function setUp(): void
    {
        $this->connection = DriverManager::getConnection([
            'driver' => 'pdo_sqlite',
            'memory' => true,
        ]);

        // Mirrors the relevant subset of OpenEMR's `extended_log` schema. The
        // production schema has more columns (auto_increment id) but the
        // recorder only writes to these six and the dedup query only reads
        // these six.
        $this->connection->executeStatement(<<<'SQL'
            CREATE TABLE extended_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NULL,
                event TEXT NULL,
                user TEXT NULL,
                recipient TEXT NULL,
                description TEXT NULL,
                patient_id INTEGER NULL
            )
        SQL);
    }

    public function testInsertsRowMatchingExtendedLogShape(): void
    {
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $recorder->record(new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T08:00:00+00:00'),
            actorUserId: 7,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/abc',
            siteId: 'default',
            patientPid: 42,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: 'jti-1',
            categories: ['allergy', 'prescription'],
            destination: 'openemr-clinical-copilot-agent',
        ));

        $row = $this->connection->fetchAssociative('SELECT * FROM extended_log WHERE patient_id = ?', [42]);
        self::assertIsArray($row);
        self::assertSame('disclosure-ai-treatment', $row['event']);
        self::assertSame('7', $row['user']);
        self::assertSame('Clinical Co-Pilot Agent', $row['recipient']);
        self::assertEquals(42, $row['patient_id']);
        self::assertSame('2026-04-30 08:00:00', $row['date']);
        self::assertIsString($row['description']);
        self::assertStringContainsString('allergy', $row['description']);
        self::assertStringContainsString('prescription', $row['description']);
    }

    public function testDedupesOnSameActorPatientDay(): void
    {
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $morning = $this->disclosure(new DateTimeImmutable('2026-04-30T08:00:00+00:00'), 'jti-1');
        $afternoon = $this->disclosure(new DateTimeImmutable('2026-04-30T15:00:00+00:00'), 'jti-2');

        $recorder->record($morning);
        $recorder->record($afternoon);

        $count = $this->connection->fetchOne('SELECT COUNT(*) FROM extended_log');
        self::assertEquals(1, $count, 'same (actor, patient, day) → exactly one extended_log row');
    }

    public function testWritesFreshRowOnNextDay(): void
    {
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $recorder->record($this->disclosure(new DateTimeImmutable('2026-04-30T20:00:00+00:00'), 'jti-1'));
        $recorder->record($this->disclosure(new DateTimeImmutable('2026-05-01T07:00:00+00:00'), 'jti-2'));

        $count = $this->connection->fetchOne('SELECT COUNT(*) FROM extended_log');
        self::assertEquals(2, $count, 'two distinct days → two extended_log rows');
    }

    public function testWritesFreshRowForDifferentPatientSameDay(): void
    {
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $recorder->record($this->disclosure(
            new DateTimeImmutable('2026-04-30T10:00:00+00:00'),
            'jti-1',
            patientPid: 42,
        ));
        $recorder->record($this->disclosure(
            new DateTimeImmutable('2026-04-30T10:30:00+00:00'),
            'jti-2',
            patientPid: 99,
        ));

        $count = $this->connection->fetchOne('SELECT COUNT(*) FROM extended_log');
        self::assertEquals(2, $count, 'two patients same day → two rows');
    }

    public function testWritesFreshRowForDifferentActorSamePatientDay(): void
    {
        // Two different clinicians covering the same patient on the same day
        // — each disclosure is its own accounting entry.
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $recorder->record($this->disclosure(
            new DateTimeImmutable('2026-04-30T10:00:00+00:00'),
            'jti-1',
            actorUserId: 7,
        ));
        $recorder->record($this->disclosure(
            new DateTimeImmutable('2026-04-30T11:00:00+00:00'),
            'jti-2',
            actorUserId: 8,
        ));

        $count = $this->connection->fetchOne('SELECT COUNT(*) FROM extended_log');
        self::assertEquals(2, $count, 'two actors same patient/day → two rows');
    }

    public function testDescriptionListsCategoriesAlphabetically(): void
    {
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $recorder->record(new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T08:00:00+00:00'),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/x',
            siteId: 'default',
            patientPid: 1,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: 'jti-cats',
            categories: ['prescription', 'allergy', 'lab'],
            destination: 'openemr-clinical-copilot-agent',
        ));

        $description = $this->connection->fetchOne('SELECT description FROM extended_log');
        self::assertIsString($description);
        // AgentDisclosure constructor sorts categories alphabetically; the
        // recorder echoes them in that order so two requests with the same
        // categories produce identical description strings.
        self::assertStringContainsString('allergy, lab, prescription', $description);
    }

    public function testEmptyCategoriesProduceLegibleDescription(): void
    {
        $recorder = new ExtendedLogDisclosureRecorder($this->connection);

        $recorder->record(new AgentDisclosure(
            disclosedAt: new DateTimeImmutable('2026-04-30T08:00:00+00:00'),
            actorUserId: 1,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/x',
            siteId: 'default',
            patientPid: 1,
            patientUuid: null,
            conversationId: null,
            action: 'echo',
            requestId: 'jti-empty',
            categories: [],
            destination: 'openemr-clinical-copilot-agent',
        ));

        $description = $this->connection->fetchOne('SELECT description FROM extended_log');
        self::assertIsString($description);
        self::assertStringContainsString('no chart categories', $description);
    }

    private function disclosure(
        DateTimeImmutable $when,
        string $requestId,
        int $actorUserId = 7,
        int $patientPid = 42,
    ): AgentDisclosure {
        return new AgentDisclosure(
            disclosedAt: $when,
            actorUserId: $actorUserId,
            actorFhirUser: 'https://emr.example/oauth2/default/Practitioner/abc',
            siteId: 'default',
            patientPid: $patientPid,
            patientUuid: null,
            conversationId: null,
            action: 'briefing',
            requestId: $requestId,
            categories: ['allergy', 'prescription'],
            destination: 'openemr-clinical-copilot-agent',
        );
    }
}
