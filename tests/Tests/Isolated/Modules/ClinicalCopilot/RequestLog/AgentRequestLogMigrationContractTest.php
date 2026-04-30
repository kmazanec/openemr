<?php

/**
 * Pins the migration's shape against the recorder's column set + the AI
 * disclosure-type seed so PHP code, SQL schema, and `list_options` data
 * can't drift from each other silently.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\RequestLog;

use OpenEMR\Modules\ClinicalCopilot\RequestLog\DbalAgentRequestLogRecorder;
use OpenEMR\Modules\ClinicalCopilot\RequestLog\ExtendedLogDisclosureRecorder;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use Symfony\Component\Process\Process;

final class AgentRequestLogMigrationContractTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/RequestLog';

    private const MIGRATION_FILE = __DIR__ . '/../../../../../../db/Migrations/Version20260430000001.php';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/AgentDisclosure.php';
        require_once self::MODULE_DIR . '/AgentRequestLogRecorder.php';
        require_once self::MODULE_DIR . '/DbalAgentRequestLogRecorder.php';
        require_once self::MODULE_DIR . '/DisclosureRecorder.php';
        require_once self::MODULE_DIR . '/ExtendedLogDisclosureRecorder.php';
    }

    public function testMigrationFileExists(): void
    {
        self::assertFileExists(self::MIGRATION_FILE);
    }

    public function testMigrationCreatesTheAgentRequestLogTable(): void
    {
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        self::assertStringContainsString(
            "new Table('" . DbalAgentRequestLogRecorder::TABLE_NAME . "')",
            $source,
            'Migration must create the table the recorder writes to',
        );
    }

    public function testMigrationDeclaresExactlyTheRecorderColumns(): void
    {
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        // Every recorder column must appear as an addColumn call in the migration.
        // Plus the auto-increment 'id' which the recorder doesn't write to.
        foreach (DbalAgentRequestLogRecorder::COLUMN_NAMES as $col) {
            self::assertMatchesRegularExpression(
                "/addColumn\\(\\s*'" . preg_quote($col, '/') . "'/",
                $source,
                "Migration must declare column '{$col}' to match the recorder",
            );
        }

        // Surface area: every addColumn() in the migration must be a known
        // column. Forces a deliberate update if anyone adds a column without
        // updating the recorder.
        preg_match_all("/addColumn\\(\\s*'([a-z_]+)'/", $source, $matches);
        $declared = $matches[1];
        $allowed = array_merge(['id'], DbalAgentRequestLogRecorder::COLUMN_NAMES);
        foreach ($declared as $col) {
            self::assertContains(
                $col,
                $allowed,
                "Migration declares unexpected column '{$col}'; either add it to "
                . 'DbalAgentRequestLogRecorder::COLUMN_NAMES or remove it from the migration',
            );
        }
    }

    public function testMigrationCarriesNoPromptOrCompletionFields(): void
    {
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        $forbidden = ['prompt', 'completion', 'request_body', 'response_body', 'message_body', 'snapshot_body'];
        foreach ($forbidden as $needle) {
            self::assertStringNotContainsStringIgnoringCase(
                "addColumn('{$needle}'",
                $source,
                "Migration must not declare a column matching '{$needle}' — disclosure is fact-of-disclosure, not body content",
            );
        }
    }

    public function testMigrationSeedsAiTreatmentDisclosureType(): void
    {
        $source = (string) file_get_contents(self::MIGRATION_FILE);

        // The list_options seed makes the disclosure-ai-treatment row appear
        // in the patient summary's Disclosures Type column with a distinct
        // label. Pin both the option_id and the alignment with the recorder.
        self::assertStringContainsString(
            "'" . ExtendedLogDisclosureRecorder::DISCLOSURE_TYPE . "'",
            $source,
            'Migration must seed the disclosure type the recorder uses',
        );
        self::assertStringContainsString(
            'list_options',
            $source,
            'Migration must INSERT into list_options',
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
            class_exists('OpenEMR\\Core\\Migrations\\Version20260430000001'),
            'Migration class must autoload after require_once',
        );
        $r = new ReflectionClass(\OpenEMR\Core\Migrations\Version20260430000001::class);
        self::assertTrue($r->isFinal());
        $parent = $r->getParentClass();
        self::assertNotFalse($parent);
        self::assertSame(\Doctrine\Migrations\AbstractMigration::class, $parent->getName());
    }
}
