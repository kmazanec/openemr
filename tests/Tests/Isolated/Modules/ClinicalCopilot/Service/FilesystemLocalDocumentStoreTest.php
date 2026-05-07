<?php

/**
 * Isolated tests for {@see FilesystemLocalDocumentStore}.
 *
 * Each test allocates its own scratch directory under
 * `sys_get_temp_dir()` so the suite stays parallel-safe and never
 * collides with another worker's fixtures.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Service;

use OpenEMR\Modules\ClinicalCopilot\Service\Production\FilesystemLocalDocumentStore;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/LocalDocumentStore.php';
require_once __DIR__
    . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Service/Production/FilesystemLocalDocumentStore.php';

#[Group('isolated')]
final class FilesystemLocalDocumentStoreTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/copilot-store-' . bin2hex(random_bytes(8));
        mkdir($this->root, 0700, true);
    }

    protected function tearDown(): void
    {
        $this->rmTree($this->root);
    }

    public function testStoreWritesBytesAndReturnsHash(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $bytes = "%PDF-1.4\nfake-pdf-bytes\n";

        $result = $store->store(4242, 'cdc-cbc.pdf', $bytes);

        $this->assertSame('cdc-cbc.pdf', $result['filename']);
        $this->assertSame(strlen($bytes), $result['size']);
        $this->assertSame(hash('sha3-512', $bytes), $result['hash']);
        $this->assertFileExists($result['absolutePath']);
        $this->assertSame($bytes, file_get_contents($result['absolutePath']));
        $this->assertStringEndsWith('/4242/cdc-cbc.pdf', $result['absolutePath']);
    }

    public function testStoreCreatesPatientDirectoryWhenMissing(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $patientDir = $this->root . '/4242';
        $this->assertDirectoryDoesNotExist($patientDir);

        $store->store(4242, 'a.pdf', 'bytes');
        $this->assertDirectoryExists($patientDir);
    }

    public function testCollisionGetsNumericSuffix(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $r1 = $store->store(4242, 'cdc-cbc.pdf', 'first');
        $r2 = $store->store(4242, 'cdc-cbc.pdf', 'second');
        $r3 = $store->store(4242, 'cdc-cbc.pdf', 'third');

        $this->assertSame('cdc-cbc.pdf', $r1['filename']);
        $this->assertSame('cdc-cbc-1.pdf', $r2['filename']);
        $this->assertSame('cdc-cbc-2.pdf', $r3['filename']);
        $this->assertFileExists($r1['absolutePath']);
        $this->assertFileExists($r2['absolutePath']);
        $this->assertFileExists($r3['absolutePath']);
        $this->assertSame('first', file_get_contents($r1['absolutePath']));
        $this->assertSame('second', file_get_contents($r2['absolutePath']));
        $this->assertSame('third', file_get_contents($r3['absolutePath']));
    }

    public function testCollisionForExtensionlessFilename(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $store->store(4242, 'README', 'first');
        $r2 = $store->store(4242, 'README', 'second');
        $this->assertSame('README-1', $r2['filename']);
    }

    public function testSanitizesPathTraversalAttempts(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        // The sanitizer must reduce arbitrary paths to a basename so a
        // malicious filename can't escape the patient directory.
        $r = $store->store(4242, '../../../etc/passwd', 'bytes');
        $this->assertSame('passwd', $r['filename']);
        $this->assertStringEndsWith('/4242/passwd', $r['absolutePath']);
        // The traversal-target file must not exist outside the dir.
        $this->assertFileDoesNotExist($this->root . '/etc/passwd');
    }

    public function testSanitizesWindowsStylePaths(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $r = $store->store(4242, 'C:\\Users\\evil\\file.pdf', 'bytes');
        $this->assertSame('file.pdf', $r['filename']);
    }

    public function testSanitizesControlCharactersAndNulls(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $r = $store->store(4242, "evi\x00l\x07.pdf", 'bytes');
        // Control chars and null bytes are stripped before basename().
        $this->assertSame('evil.pdf', $r['filename']);
    }

    public function testFallsBackWhenSanitizationProducesEmpty(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $r = $store->store(4242, '...', 'bytes');
        $this->assertMatchesRegularExpression('/^upload-[0-9a-f]{16}$/', $r['filename']);
    }

    public function testFallsBackWhenSanitizationProducesDotPrefix(): void
    {
        // Hidden files would dodge directory listings — use the fallback
        // name + extension instead of `.htaccess`.
        $store = new FilesystemLocalDocumentStore($this->root);
        $r = $store->store(4242, '.htaccess', 'bytes');
        $this->assertMatchesRegularExpression('/^upload-[0-9a-f]{16}\.htaccess$/', $r['filename']);
    }

    public function testRejectsZeroPid(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $this->expectException(\DomainException::class);
        $store->store(0, 'a.pdf', 'bytes');
    }

    public function testRejectsEmptyBytes(): void
    {
        $store = new FilesystemLocalDocumentStore($this->root);
        $this->expectException(\DomainException::class);
        $store->store(1, 'a.pdf', '');
    }

    public function testRejectsEmptyDocumentsRoot(): void
    {
        $this->expectException(\DomainException::class);
        new FilesystemLocalDocumentStore('');
    }

    private function rmTree(string $path): void
    {
        if (!file_exists($path)) {
            return;
        }
        if (is_file($path) || is_link($path)) {
            @unlink($path);
            return;
        }
        $entries = @scandir($path);
        if ($entries === false) {
            return;
        }
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $this->rmTree($path . '/' . $entry);
        }
        @rmdir($path);
    }
}
