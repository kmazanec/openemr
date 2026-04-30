<?php

/**
 * Isolated structural test for the Clinical Co-Pilot module skeleton.
 *
 * The module is loaded at runtime by OpenEMR's ModulesApplication only
 * after an admin enables it under Modules → Manage Modules. These
 * checks just verify the on-disk shape the installer scans for so the
 * module can be discovered and toggled on without surprises.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Process\Process;

final class ModuleSkeletonTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../interface/modules/custom_modules/oe-module-clinical-copilot';

    public function testInfoTxtExistsAndCarriesDisplayName(): void
    {
        $infoPath = self::MODULE_DIR . '/info.txt';
        $this->assertFileExists($infoPath);

        $lines = file($infoPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        $this->assertNotFalse($lines);
        $this->assertNotEmpty($lines, 'info.txt must declare a display name on line 1');
        $this->assertStringContainsString(
            'Clinical Co-Pilot',
            $lines[0],
            'Module installer reads line 1 of info.txt as the display name',
        );
    }

    public function testRuntimeBootstrapEntrypointExists(): void
    {
        $this->assertFileExists(self::MODULE_DIR . '/openemr.bootstrap.php');
    }

    public function testAgentProxyEntryFileExists(): void
    {
        // Phase 1.4 ships the browser entry at public/agent.php; it is the
        // URL surface the in-OpenEMR JS bundle calls.
        $this->assertFileExists(self::MODULE_DIR . '/public/agent.php');
    }

    public function testComposerManifestDeclaresPsr4Namespace(): void
    {
        $composerPath = self::MODULE_DIR . '/composer.json';
        $this->assertFileExists($composerPath);

        $contents = file_get_contents($composerPath);
        $this->assertNotFalse($contents);
        $manifest = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
        $this->assertIsArray($manifest);

        $autoload = $manifest['autoload'] ?? null;
        $this->assertIsArray($autoload);
        $psr4 = $autoload['psr-4'] ?? null;
        $this->assertIsArray($psr4);
        $this->assertSame(
            'src/',
            $psr4['OpenEMR\\Modules\\ClinicalCopilot\\'] ?? null,
            'Module composer.json must map OpenEMR\\Modules\\ClinicalCopilot\\ to src/',
        );
    }

    public function testBootstrapClassLoadsAndIsTaggedToDirectory(): void
    {
        require_once self::MODULE_DIR . '/src/Bootstrap.php';

        $class = \OpenEMR\Modules\ClinicalCopilot\Bootstrap::class;
        $this->assertTrue(class_exists($class, false), "Bootstrap class {$class} must be defined");

        // MODULE_NAME must match the directory the module ships in —
        // OpenEMR's installer reads `mod_directory` from this same name.
        $this->assertSame(basename(self::MODULE_DIR), constant($class . '::MODULE_NAME'));
    }

    /**
     * @return iterable<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function expectedSubdirectories(): iterable
    {
        yield 'src/Auth' => ['src/Auth'];
        yield 'src/Controller' => ['src/Controller'];
        yield 'src/Service' => ['src/Service'];
        yield 'templates' => ['templates'];
        yield 'public/js' => ['public/js'];
        yield 'public/css' => ['public/css'];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('expectedSubdirectories')]
    public function testSkeletonHasRequiredSubdirectories(string $relativePath): void
    {
        $this->assertDirectoryExists(self::MODULE_DIR . '/' . $relativePath);
    }

    /**
     * `InstallerController::scanAndRegisterCustomModules` enumerates
     * `interface/modules/custom_modules/` with `opendir → is_dir`,
     * filtering out `.`, `..`, and `Application`. Anything else surviving
     * that filter is a candidate the installer will register. This test
     * pins the file-system shape that scanner reads — without a DB.
     */
    public function testInstallerScannerWouldDiscoverThisModule(): void
    {
        $customDir = realpath(self::MODULE_DIR . '/..');
        $this->assertNotFalse($customDir, 'custom_modules parent must resolve');

        $candidates = [];
        $handle = opendir($customDir);
        $this->assertNotFalse($handle);
        try {
            while (false !== ($entry = readdir($handle))) {
                if (in_array($entry, ['.', '..', 'Application'], true)) {
                    continue;
                }
                if (is_dir($customDir . '/' . $entry)) {
                    $candidates[] = $entry;
                }
            }
        } finally {
            closedir($handle);
        }

        $this->assertContains(
            basename(self::MODULE_DIR),
            $candidates,
            'Installer scanner must enumerate this module under custom_modules/',
        );
    }

    /**
     * `InstModuleTable::register()` reads line 1 of `info.txt` as
     * `mod_name`. If `info.txt` is missing or empty, the directory name
     * is used as a fallback — but having an explicit display name is
     * what makes the module installer UI legible. Pin both pieces.
     */
    public function testInfoTxtFirstLineIsTheRegisteredModName(): void
    {
        $infoPath = self::MODULE_DIR . '/info.txt';
        $lines = file($infoPath);
        $this->assertNotFalse($lines);
        $this->assertNotEmpty($lines, 'info.txt must have a non-empty first line');

        $modName = trim($lines[0]);
        $this->assertNotSame('', $modName, 'mod_name must not be the empty string');
        $this->assertStringStartsWith(
            'Clinical Co-Pilot',
            $modName,
            'mod_name (from info.txt line 1) is the human-readable label in Manage Modules',
        );
    }

    /**
     * A syntax error in `openemr.bootstrap.php` would prevent
     * `ModulesApplication` from loading the module at runtime — and
     * surfaces only when the module is enabled. Catch it in CI instead.
     */
    public function testRuntimeBootstrapEntrypointParsesCleanly(): void
    {
        $entry = self::MODULE_DIR . '/openemr.bootstrap.php';
        $process = new Process([PHP_BINARY, '-l', $entry]);
        $process->run();
        $this->assertSame(
            0,
            $process->getExitCode(),
            "openemr.bootstrap.php must parse: "
                . $process->getOutput()
                . $process->getErrorOutput(),
        );
    }
}
