<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Schedule;

use DateTimeImmutable;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use OpenEMR\Modules\ClinicalCopilot\Schedule\MorningPrepGate;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use PHPUnit\Framework\TestCase;

final class MorningPrepGateTest extends TestCase
{
    private const MODULE_SETTINGS_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Settings';

    private const MODULE_SCHEDULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Schedule';

    private Connection $connection;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SETTINGS_DIR . '/PractitionerSettings.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsRepository.php';
        require_once self::MODULE_SCHEDULE_DIR . '/MorningPrepGate.php';
    }

    protected function setUp(): void
    {
        if (!extension_loaded('pdo_sqlite')) {
            self::markTestSkipped('pdo_sqlite extension required for MorningPrepGate');
        }

        $this->connection = DriverManager::getConnection([
            'driver' => 'pdo_sqlite',
            'memory' => true,
        ]);
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

    public function testReturnsFalseForEmptyUuid(): void
    {
        $gate = new MorningPrepGate(new SettingsRepository($this->connection));

        self::assertFalse($gate->isEnabledFor(''));
    }

    public function testReturnsFalseForUnknownPractitioner(): void
    {
        // Default-disabled is the whole story for §5.4. A practitioner
        // who has never visited the settings page must produce zero
        // round-trips — not a degraded "agent says no rows" loop.
        $gate = new MorningPrepGate(new SettingsRepository($this->connection));

        self::assertFalse($gate->isEnabledFor('a8f5f167-f44f-4964-ad62-30e69e7e90d6'));
    }

    public function testReturnsFalseWhenPractitionerHasOptedOut(): void
    {
        $repo = new SettingsRepository($this->connection);
        $repo->upsert(new PractitionerSettings(
            practitionerUuid: 'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            morningPrepEnabled: false,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        ));
        $gate = new MorningPrepGate($repo);

        self::assertFalse($gate->isEnabledFor('a8f5f167-f44f-4964-ad62-30e69e7e90d6'));
    }

    public function testReturnsTrueWhenPractitionerHasOptedIn(): void
    {
        $repo = new SettingsRepository($this->connection);
        $repo->upsert(new PractitionerSettings(
            practitionerUuid: 'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50:00',
            timezone: 'America/Chicago',
            updatedAt: new DateTimeImmutable('2026-05-02T12:00:00+00:00'),
        ));
        $gate = new MorningPrepGate($repo);

        self::assertTrue($gate->isEnabledFor('a8f5f167-f44f-4964-ad62-30e69e7e90d6'));
    }

    public function testFailsOpenWhenSettingsLookupThrows(): void
    {
        // A broken settings table must not erase annotations for
        // every clinician — see MorningPrepGate's class docblock for
        // the rationale. Drop the table so any query raises, then
        // confirm the gate reports "enabled" so the agent's own
        // empty-list response can take over without the schedule view
        // going dark.
        $this->connection->executeStatement('DROP TABLE agent_practitioner_settings');
        $gate = new MorningPrepGate(new SettingsRepository($this->connection));

        self::assertTrue($gate->isEnabledFor('a8f5f167-f44f-4964-ad62-30e69e7e90d6'));
    }
}
