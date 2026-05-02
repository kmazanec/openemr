<?php

/**
 * Pins the agent_practitioner_settings migration's column shape against
 * the repository so SQL schema and PHP can't drift silently.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Settings;

use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsRepository;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use Symfony\Component\Process\Process;

final class SettingsMigrationContractTest extends TestCase
{
    private const MODULE_SETTINGS_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Settings';

    private const MIGRATION_FILE = __DIR__ . '/../../../../../../db/Migrations/Version20260502000001.php';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SETTINGS_DIR . '/PractitionerSettings.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsRepository.php';
    }

    public function testMigrationFileExists(): void
    {
        self::assertFileExists(self::MIGRATION_FILE);
    }

    public function testMigrationCreatesTheSettingsTable(): void
    {
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        self::assertStringContainsString(
            "new Table('" . SettingsRepository::TABLE_NAME . "')",
            $source,
            'Migration must create the table the repository reads/writes',
        );
    }

    public function testMigrationDeclaresExactlyTheRepositoryColumns(): void
    {
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        foreach (SettingsRepository::COLUMN_NAMES as $col) {
            self::assertMatchesRegularExpression(
                "/addColumn\\(\\s*'" . preg_quote($col, '/') . "'/",
                $source,
                "Migration must declare column '{$col}' to match the repository",
            );
        }

        // Surface area: every addColumn() in the migration must be a known
        // column. Forces a deliberate update if anyone adds a column
        // without telling the repository.
        preg_match_all("/addColumn\\(\\s*'([a-z_]+)'/", $source, $matches);
        $declared = $matches[1];
        foreach ($declared as $col) {
            self::assertContains(
                $col,
                SettingsRepository::COLUMN_NAMES,
                "Migration declares unexpected column '{$col}'; either add it to "
                . 'SettingsRepository::COLUMN_NAMES or remove it from the migration',
            );
        }
    }

    public function testMigrationDefaultsArePlanCompliant(): void
    {
        // Plan §5.2: the table must default to OFF (opt-in) with a 07:50
        // default time and America/Chicago default timezone.
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        self::assertMatchesRegularExpression(
            "/addColumn\\(\\s*'morning_prep_enabled'.*'default'\\s*=>\\s*false/s",
            $source,
            'morning_prep_enabled must default to false (opt-in)',
        );
        self::assertStringContainsString(
            "'07:50",
            $source,
            'morning_prep_time_local must default to 07:50',
        );
        self::assertStringContainsString(
            "'America/Chicago'",
            $source,
            'timezone must default to America/Chicago',
        );
    }

    public function testMigrationIsParseable(): void
    {
        $process = new Process(['php', '-l', self::MIGRATION_FILE]);
        $process->run();
        self::assertSame(
            0,
            $process->getExitCode(),
            'Migration must be syntactically valid PHP: ' . $process->getOutput() . $process->getErrorOutput(),
        );
    }

    public function testMigrationClassExtendsAbstractMigration(): void
    {
        require_once self::MIGRATION_FILE;
        self::assertTrue(
            class_exists('OpenEMR\\Core\\Migrations\\Version20260502000001'),
            'Migration class must autoload after require_once',
        );
        $r = new ReflectionClass(\OpenEMR\Core\Migrations\Version20260502000001::class);
        self::assertTrue($r->isFinal());
        $parent = $r->getParentClass();
        self::assertNotFalse($parent);
        self::assertSame(\Doctrine\Migrations\AbstractMigration::class, $parent->getName());
    }
}
