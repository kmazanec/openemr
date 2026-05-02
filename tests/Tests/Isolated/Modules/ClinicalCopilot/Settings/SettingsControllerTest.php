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
use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDenyReason;
use OpenEMR\Modules\ClinicalCopilot\Controller\SettingsController;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsPolicyGate;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use PHPUnit\Framework\TestCase;

final class SettingsControllerTest extends TestCase
{
    private const ACTING_UUID = 'a8f5f167-f44f-4964-ad62-30e69e7e90d6';
    private const OTHER_UUID = 'b9c66377-1234-4eef-9999-30e69e7e9999';

    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    private const MODULE_SETTINGS_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Settings';

    private const MODULE_CONTROLLER_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller';

    private Connection $connection;

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_AUTH_DIR . '/PolicyDenyReason.php';
        require_once self::MODULE_AUTH_DIR . '/PolicyDecision.php';
        require_once self::MODULE_AUTH_DIR . '/ClockInterface.php';
        require_once self::MODULE_SETTINGS_DIR . '/PractitionerSettings.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsRepository.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsPolicyGate.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsControllerResult.php';
        require_once self::MODULE_CONTROLLER_DIR . '/SettingsController.php';
    }

    protected function setUp(): void
    {
        if (!extension_loaded('pdo_sqlite')) {
            self::markTestSkipped('pdo_sqlite extension required');
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

    public function testHappyPathWritesOwnRow(): void
    {
        $controller = $this->controller();

        $result = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50',
            timezone: 'America/Chicago',
        );

        self::assertTrue($result->ok);
        self::assertSame([], $result->errors);
        self::assertNotNull($result->savedRow);
        self::assertSame(self::ACTING_UUID, $result->savedRow->practitionerUuid);
        self::assertTrue($result->savedRow->morningPrepEnabled);
        self::assertSame('07:50:00', $result->savedRow->morningPrepTimeLocal);
        self::assertSame('America/Chicago', $result->savedRow->timezone);

        // Persisted in DB
        $repo = new SettingsRepository($this->connection);
        $loaded = $repo->find(self::ACTING_UUID);
        self::assertNotNull($loaded);
        self::assertTrue($loaded->morningPrepEnabled);
    }

    public function testCrossWriteIsDeniedAndDoesNotPersist(): void
    {
        // Plan §5.2: "settings page writes only the acting user's row —
        // no admin-edits-others surface this sprint."
        $controller = $this->controller();

        $result = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::OTHER_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50',
            timezone: 'America/Chicago',
        );

        self::assertFalse($result->ok);
        self::assertArrayHasKey('policy', $result->errors);
        self::assertSame(PolicyDenyReason::NotOwnRow->name, $result->errors['policy']);
        self::assertNull($result->savedRow);

        $repo = new SettingsRepository($this->connection);
        self::assertNull($repo->find(self::ACTING_UUID));
        self::assertNull($repo->find(self::OTHER_UUID));
    }

    public function testInvalidTimeIsRejectedAndDoesNotPersist(): void
    {
        $controller = $this->controller();

        $result = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '25:99',
            timezone: 'America/Chicago',
        );

        self::assertFalse($result->ok);
        self::assertArrayHasKey('morning_prep_time_local', $result->errors);
        self::assertNull($result->savedRow);

        $repo = new SettingsRepository($this->connection);
        self::assertNull($repo->find(self::ACTING_UUID));
    }

    public function testEmptyTimeIsRejected(): void
    {
        $controller = $this->controller();

        $result = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '',
            timezone: 'America/Chicago',
        );

        self::assertFalse($result->ok);
        self::assertArrayHasKey('morning_prep_time_local', $result->errors);
    }

    public function testInvalidTimezoneIsRejectedAndDoesNotPersist(): void
    {
        $controller = $this->controller();

        $result = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50',
            timezone: 'Mars/Phobos',
        );

        self::assertFalse($result->ok);
        self::assertArrayHasKey('timezone', $result->errors);
        self::assertNull($result->savedRow);

        $repo = new SettingsRepository($this->connection);
        self::assertNull($repo->find(self::ACTING_UUID));
    }

    public function testTogglingFromTrueToFalseIsIdempotentAndExcludesFromEnabledList(): void
    {
        // Plan §5.2 last bullet: "toggling morning_prep_enabled to false
        // cancels any scheduled run for that practitioner (idempotent)."
        // The §5.3 precompute job will read findEnabledPractitioners() to
        // pick whose schedules to fan out — so cancellation = exclusion
        // from that query, and idempotent = same row state on repeat write.
        $controller = $this->controller();
        $repo = new SettingsRepository($this->connection);

        // Start enabled.
        $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50',
            timezone: 'America/Chicago',
        );
        self::assertCount(1, $repo->findEnabledPractitioners());

        // Disable twice.
        $first = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: false,
            morningPrepTimeLocal: '07:50',
            timezone: 'America/Chicago',
        );
        $second = $controller->save(
            actingPractitionerUuid: self::ACTING_UUID,
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: false,
            morningPrepTimeLocal: '07:50',
            timezone: 'America/Chicago',
        );

        self::assertTrue($first->ok);
        self::assertTrue($second->ok);

        // Two equivalent disable writes produce the same observable row.
        self::assertNotNull($first->savedRow);
        self::assertNotNull($second->savedRow);
        self::assertFalse($first->savedRow->morningPrepEnabled);
        self::assertFalse($second->savedRow->morningPrepEnabled);

        // Cancellation: precompute job's selector excludes the uuid.
        $enabled = $repo->findEnabledPractitioners();
        $enabledUuids = array_map(static fn(PractitionerSettings $s): string => $s->practitionerUuid, $enabled);
        self::assertNotContains(self::ACTING_UUID, $enabledUuids);
    }

    public function testEmptyActingUuidIsDenied(): void
    {
        $controller = $this->controller();

        $result = $controller->save(
            actingPractitionerUuid: '',
            targetPractitionerUuid: self::ACTING_UUID,
            morningPrepEnabled: true,
            morningPrepTimeLocal: '07:50',
            timezone: 'America/Chicago',
        );

        self::assertFalse($result->ok);
        self::assertArrayHasKey('policy', $result->errors);
        self::assertSame(PolicyDenyReason::MissingSession->name, $result->errors['policy']);
    }

    private function controller(): SettingsController
    {
        return new SettingsController(
            repository: new SettingsRepository($this->connection),
            policyGate: new SettingsPolicyGate(),
            clock: new class implements ClockInterface {
                public function now(): DateTimeImmutable
                {
                    return new DateTimeImmutable('2026-05-02T12:00:00+00:00');
                }
            },
        );
    }
}
