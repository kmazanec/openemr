<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Settings;

use DateTimeImmutable;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use PHPUnit\Framework\TestCase;

final class SettingsRepositoryTest extends TestCase
{
    private const MODULE_SETTINGS_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Settings';

    private Connection $connection;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SETTINGS_DIR . '/PractitionerSettings.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsRepository.php';
    }

    protected function setUp(): void
    {
        if (!extension_loaded('pdo_sqlite')) {
            self::markTestSkipped('pdo_sqlite extension required for SettingsRepository round-trip');
        }

        $this->connection = DriverManager::getConnection([
            'driver' => 'pdo_sqlite',
            'memory' => true,
        ]);

        // Schema mirrors db/Migrations/Version20260502000001.php. SQLite is
        // lenient on types, so the value is in column *names* — they must
        // match what SettingsRepository reads/writes.
        $this->connection->executeStatement(<<<'SQL'
            CREATE TABLE agent_practitioner_settings (
                practitioner_uuid TEXT PRIMARY KEY,
                morning_prep_enabled INTEGER NOT NULL DEFAULT 0,
                morning_prep_time_local TEXT NOT NULL DEFAULT '07:50:00',
                timezone TEXT NOT NULL DEFAULT 'America/Chicago',
                updated_at TEXT NOT NULL
            )
        SQL);
    }

    public function testFindReturnsNullForUnknownUuid(): void
    {
        $repo = new SettingsRepository($this->connection);

        self::assertNull($repo->find('a8f5f167-f44f-4964-ad62-30e69e7e90d6'));
    }

    public function testUpsertInsertsAndFindRoundTrips(): void
    {
        $repo = new SettingsRepository($this->connection);

        $row = new PractitionerSettings(
            practitionerUuid: 'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        );

        $repo->upsert($row);

        $loaded = $repo->find('a8f5f167-f44f-4964-ad62-30e69e7e90d6');
        self::assertNotNull($loaded);
        self::assertSame('a8f5f167-f44f-4964-ad62-30e69e7e90d6', $loaded->practitionerUuid);
        self::assertTrue($loaded->morningPrepEnabled);
        self::assertSame('07:50:00', $loaded->morningPrepTimeLocal);
        self::assertSame('America/Chicago', $loaded->timezone);
    }

    public function testUpsertUpdatesExistingRow(): void
    {
        $repo = new SettingsRepository($this->connection);
        $uuid = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';

        $repo->upsert(new PractitionerSettings(
            practitionerUuid: $uuid,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        ));

        $repo->upsert(new PractitionerSettings(
            practitionerUuid: $uuid,
            morningPrepEnabled: false,
            morningPrepTimeLocal: '08:30:00',
            timezone: 'America/New_York',
            updatedAt: new DateTimeImmutable('2026-05-02T13:00:00+00:00'),
        ));

        $loaded = $repo->find($uuid);
        self::assertNotNull($loaded);
        self::assertFalse($loaded->morningPrepEnabled);
        self::assertSame('08:30:00', $loaded->morningPrepTimeLocal);
        self::assertSame('America/New_York', $loaded->timezone);

        // Single-row guarantee: upsert must not duplicate on conflict.
        $count = $this->connection->fetchOne(
            'SELECT COUNT(*) FROM agent_practitioner_settings WHERE practitioner_uuid = ?',
            [$uuid],
        );
        self::assertEquals(1, $count);
    }

    public function testFindEnabledPractitionersReturnsOnlyEnabled(): void
    {
        $repo = new SettingsRepository($this->connection);

        $repo->upsert(new PractitionerSettings(
            practitionerUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        ));
        $repo->upsert(new PractitionerSettings(
            practitionerUuid: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
            morningPrepEnabled: false,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        ));

        $enabled = $repo->findEnabledPractitioners();

        self::assertCount(1, $enabled);
        self::assertSame('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', $enabled[0]->practitionerUuid);
    }

    public function testTogglingEnabledFromTrueToFalseIsIdempotent(): void
    {
        // Plan §5.2: "toggling morning_prep_enabled to false cancels any
        // scheduled run for that practitioner (idempotent)". The §5.3
        // precompute job will read findEnabledPractitioners() to decide
        // whose schedules to fan out — so the contract that matters is:
        // (a) writing enabled=false twice produces the same row, and
        // (b) findEnabledPractitioners() excludes the disabled uuid.
        $repo = new SettingsRepository($this->connection);
        $uuid = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';

        $repo->upsert(new PractitionerSettings(
            practitionerUuid: $uuid,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        ));

        $disable = new PractitionerSettings(
            practitionerUuid: $uuid,
            morningPrepEnabled: false,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T13:00:00+00:00'),
        );
        $repo->upsert($disable);
        $repo->upsert($disable);

        $loaded = $repo->find($uuid);
        self::assertNotNull($loaded);
        self::assertFalse($loaded->morningPrepEnabled);

        $enabled = $repo->findEnabledPractitioners();
        $enabledUuids = array_map(static fn(PractitionerSettings $s): string => $s->practitionerUuid, $enabled);
        self::assertNotContains($uuid, $enabledUuids);
    }

}
