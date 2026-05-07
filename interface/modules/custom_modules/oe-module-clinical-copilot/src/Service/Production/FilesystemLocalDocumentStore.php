<?php

/**
 * Filesystem-backed {@see LocalDocumentStore} implementation. Writes
 * canonical chat-upload bytes under `<documents-root>/<pid>/` so the
 * legacy Documents-tab viewer can render them — the viewer keys off
 * `type='file_url'` + `path_depth=1` and reconstructs the path as
 * `OE_SITE_DIR/documents/<pid>/<basename>` (see
 * {@see \C_Document::retrieve_action}).
 *
 * Hashing matches {@see \Document::createDocument}: the legacy uploader
 * stores `hash('sha3-512', $data)` in `documents.hash`. Using the same
 * algorithm keeps the chat-uploaded rows indistinguishable from
 * legacy-uploaded ones at the table level.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service\Production;

use OpenEMR\Modules\ClinicalCopilot\Service\LocalDocumentStore;

final readonly class FilesystemLocalDocumentStore implements LocalDocumentStore
{
    private const HASH_ALGO = 'sha3-512';
    private const DIR_MODE = 0700;
    private const MAX_COLLISION_TRIES = 10000;

    public function __construct(private string $documentsRoot)
    {
        if ($documentsRoot === '') {
            throw new \DomainException('documentsRoot must be non-empty');
        }
    }

    /**
     * @return array{filename: string, absolutePath: string, hash: string, size: int}
     */
    public function store(int $pid, string $originalFilename, string $bytes): array
    {
        if ($pid <= 0) {
            throw new \DomainException('pid must be positive');
        }
        if ($bytes === '') {
            throw new \DomainException('bytes must be non-empty');
        }

        $safeBasename = $this->sanitizeFilename($originalFilename);
        $patientDir = rtrim($this->documentsRoot, '/') . '/' . $pid;

        if (!is_dir($patientDir) && !@mkdir($patientDir, self::DIR_MODE, true) && !is_dir($patientDir)) {
            throw new \RuntimeException('Unable to create patient documents directory');
        }

        $finalFilename = $this->resolveCollision($patientDir, $safeBasename);
        $absolutePath = $patientDir . '/' . $finalFilename;

        $written = @file_put_contents($absolutePath, $bytes);
        $expected = strlen($bytes);
        if ($written === false || $written !== $expected) {
            // Best effort cleanup so we don't leave a half-written file.
            if (is_file($absolutePath)) {
                @unlink($absolutePath);
            }
            throw new \RuntimeException('Failed to write document bytes to disk');
        }

        return [
            'filename' => $finalFilename,
            'absolutePath' => $absolutePath,
            'hash' => hash(self::HASH_ALGO, $bytes),
            'size' => $expected,
        ];
    }

    /**
     * Reduce an arbitrary client-supplied name to a safe basename:
     *   - strip path components (handle both `/` and `\`)
     *   - strip control chars and null bytes
     *   - reject names that would collapse to empty / `.` / `..` and
     *     fall back to a random hex name + the original extension
     *
     * The legacy uploader stores files under a fresh UUID, so the
     * "original filename" only ever appears in `documents.name`. We
     * preserve it on disk too — the user expects chat uploads to be
     * indistinguishable from legacy uploads in the file tree, and the
     * viewer reconstructs the path from the URL regardless of what the
     * filename happens to be.
     */
    private function sanitizeFilename(string $name): string
    {
        $stripped = preg_replace('/[\x00-\x1f\x7f]/', '', $name);
        if (!is_string($stripped)) {
            $stripped = '';
        }
        // Strip directory components from both POSIX and Windows-style
        // paths — basename() respects only the platform separator.
        $normalized = str_replace('\\', '/', $stripped);
        $base = basename($normalized);
        $base = trim($base);

        if (in_array($base, ['', '.', '..'], true)) {
            return $this->fallbackName($name);
        }

        // Forbid leading dots so we don't write hidden files (`.htaccess`).
        if (str_starts_with($base, '.')) {
            return $this->fallbackName($name);
        }

        return $base;
    }

    /**
     * Build a synthetic name when the input sanitizes to empty. Keeps
     * the original extension when it's printable so the viewer's MIME
     * guesses (and the file utility) still cooperate.
     */
    private function fallbackName(string $original): string
    {
        $ext = '';
        $dot = strrpos($original, '.');
        if ($dot !== false && $dot < strlen($original) - 1) {
            $candidate = substr($original, $dot + 1);
            $extClean = preg_replace('/[^A-Za-z0-9]/', '', $candidate);
            if (is_string($extClean) && $extClean !== '') {
                $ext = '.' . strtolower(substr($extClean, 0, 16));
            }
        }
        return 'upload-' . bin2hex(random_bytes(8)) . $ext;
    }

    /**
     * Append `-1`, `-2`, ... before the extension until a free slot is
     * found in `$dir`. Caller has already ensured the dir exists.
     */
    private function resolveCollision(string $dir, string $filename): string
    {
        $candidate = $dir . '/' . $filename;
        if (!file_exists($candidate)) {
            return $filename;
        }

        $dot = strrpos($filename, '.');
        if ($dot === false || $dot === 0) {
            $stem = $filename;
            $ext = '';
        } else {
            $stem = substr($filename, 0, $dot);
            $ext = substr($filename, $dot);
        }

        for ($i = 1; $i <= self::MAX_COLLISION_TRIES; $i++) {
            $next = $stem . '-' . $i . $ext;
            if (!file_exists($dir . '/' . $next)) {
                return $next;
            }
        }
        throw new \RuntimeException('Unable to resolve filename collision');
    }
}
