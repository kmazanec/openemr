<?php

/**
 * Boundary between {@see DocumentReferenceWriteService} and the local
 * filesystem under `OE_SITE_DIR/documents/<pid>/`.
 *
 * The chat-upload path stores canonical bytes both in DigitalOcean
 * Spaces (so the agent's vision pipeline can pull bytes for the
 * external LLM) and on local disk in the exact shape the legacy
 * Documents-tab viewer expects (`type='file_url'`, `path_depth=1`,
 * URL = `file://<dir>/<pid>/<filename>`). This interface owns the
 * disk-write half of that pair.
 *
 * Splitting the disk surface from the SQL surface keeps the writer
 * service free of filesystem state and keeps both implementations
 * trivially testable in isolation.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface LocalDocumentStore
{
    /**
     * Persist `$bytes` under `<documents-root>/<pid>/<filename>`.
     *
     * The implementation sanitizes `$originalFilename` to a safe
     * basename, resolves collisions by appending `-1`, `-2`, ... before
     * the extension, computes a hash matching the legacy
     * {@see \Document::createDocument} algorithm, and verifies the byte
     * count after `file_put_contents`.
     *
     * @return array{filename: string, absolutePath: string, hash: string, size: int}
     *
     * @throws \RuntimeException on filesystem I/O failure.
     */
    public function store(int $pid, string $originalFilename, string $bytes): array;
}
