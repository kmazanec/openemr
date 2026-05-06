<?php

/**
 * Boundary between {@see DocumentReferenceWriteService} and OpenEMR's
 * `documents` / `categories` / `categories_to_documents` tables.
 *
 * Splitting this surface out of DBAL makes the writer trivially
 * testable (in-memory implementation in tests; real DBAL connection
 * in production) and keeps the service itself free of SQL strings.
 *
 * The transactional boundary lives in the implementation, not in
 * the service: `insertDocumentReferenceRow` returns the new
 * `documents.id` and binds the categorization in a single atomic
 * unit. A leaked half-row is observably worse than a re-insert,
 * so the rollback responsibility sits with the implementation that
 * actually owns the connection.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

interface DocumentTableWriter
{
    /**
     * Find the leaf category id for the W2 doc type, creating the
     * "Clinical Copilot" root and "Lab PDF" / "Intake Form" leaf if
     * either is missing. Idempotent.
     *
     * @param string $docType `'lab_pdf' | 'intake_form'`.
     */
    public function ensureCategory(string $docType): int;

    /**
     * Insert a `documents` row with the agent-supplied uuid binary,
     * categorize it under `$categoryId`, and return the autoincrement
     * `documents.id`. Implementation owns the transaction.
     *
     * @param string $uuidBinary 16-byte BINARY(16) value for `documents.uuid`.
     */
    public function insertDocumentReferenceRow(
        int $pid,
        string $uuidBinary,
        string $url,
        string $mimeType,
        string $filename,
        \DateTimeImmutable $createdAt,
        int $categoryId,
    ): int;
}
