<?php

/**
 * Production wiring for {@see DocumentTableWriter}: writes through
 * Doctrine DBAL into OpenEMR's `documents`, `categories`, and
 * `categories_to_documents` tables.
 *
 * The transaction guards the documents + categories_to_documents
 * insert pair: a categorized-but-orphaned document confuses the
 * existing document UI, and an uncategorized row is invisible. Either
 * both land or neither does. Category creation is *outside* the
 * transaction because it's idempotent on `(name, parent)` and the
 * race between two concurrent extractions creating the same category
 * is benign — both can call `ensureCategory` and at most one create
 * succeeds; the other reads back the winner.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service\Production;

use Doctrine\DBAL\Connection;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentTableWriter;

final readonly class DbalDocumentTableWriter implements DocumentTableWriter
{
    private const ROOT_CATEGORY_NAME = 'Clinical Copilot';
    private const LEAF_CATEGORY_NAME_LAB = 'Lab PDF';
    private const LEAF_CATEGORY_NAME_INTAKE = 'Intake Form';

    public function __construct(private Connection $connection)
    {
    }

    public function ensureCategory(string $docType): int
    {
        $rootId = $this->findOrCreateCategory(self::ROOT_CATEGORY_NAME, parentId: 1);
        $leafName = $docType === DocumentReferenceWriteService::DOC_TYPE_LAB_PDF
            ? self::LEAF_CATEGORY_NAME_LAB
            : self::LEAF_CATEGORY_NAME_INTAKE;
        return $this->findOrCreateCategory($leafName, parentId: $rootId);
    }

    public function insertDocumentReferenceRow(
        int $pid,
        string $uuidBinary,
        string $url,
        string $mimeType,
        string $filename,
        \DateTimeImmutable $createdAt,
        int $categoryId,
    ): int {
        $this->connection->beginTransaction();
        try {
            $this->connection->insert('documents', [
                'uuid' => $uuidBinary,
                'type' => 'web_url',
                'url' => $url,
                'mimetype' => $mimeType,
                'name' => $filename,
                'date' => $createdAt->format('Y-m-d H:i:s'),
                'docdate' => $createdAt->format('Y-m-d'),
                'foreign_id' => $pid,
                'storagemethod' => 0,
                'deleted' => 0,
                'encrypted' => 0,
                'list_id' => 0,
                'encounter_id' => 0,
                'encounter_check' => 0,
                'imported' => 0,
                'audit_master_approval_status' => 1,
            ]);
            $documentRowIdRaw = $this->connection->lastInsertId();
            if (!is_numeric($documentRowIdRaw)) {
                throw new \RuntimeException('documents insert did not return an autoincrement id');
            }
            $documentRowId = (int) $documentRowIdRaw;

            $this->connection->insert('categories_to_documents', [
                'category_id' => $categoryId,
                'document_id' => $documentRowId,
            ]);

            $this->connection->commit();
            return $documentRowId;
        } catch (\Throwable $e) {
            $this->connection->rollBack();
            throw $e;
        }
    }

    private function findOrCreateCategory(string $name, int $parentId): int
    {
        $existing = $this->connection->fetchOne(
            'SELECT id FROM categories WHERE name = ? AND parent = ?',
            [$name, $parentId],
        );
        if (is_numeric($existing)) {
            return (int) $existing;
        }

        // OpenEMR's `categories.id` is `int NOT NULL DEFAULT 0` — NOT
        // auto-increment. The application convention is to mint a fresh
        // id via the `sequences` helper table (which IS auto-increment)
        // and write it explicitly. Doctrine's `lastInsertId()` returns
        // 0 against a non-AUTO_INCREMENT primary key, so the second
        // INSERT would collide on `id=0` if we relied on it.
        $newId = $this->generateSequenceId();

        $this->connection->insert('categories', [
            'id' => $newId,
            'name' => $name,
            'value' => '',
            'parent' => $parentId,
            'lft' => 0,
            'rght' => 0,
            'aco_spec' => 'patients|docs',
            'codes' => '',
        ]);
        return $newId;
    }

    /**
     * Mint a fresh integer id from the OpenEMR `sequences` table — same
     * pattern as `QueryUtils::generateId()` but expressed through the
     * DBAL connection this writer already holds (avoids a cross-DB
     * dependency on ADOdb).
     */
    private function generateSequenceId(): int
    {
        $this->connection->executeStatement('INSERT INTO sequences VALUES (NULL)');
        $idRaw = $this->connection->lastInsertId();
        if (!is_numeric($idRaw) || (int) $idRaw <= 0) {
            throw new \RuntimeException('sequences insert did not return an autoincrement id');
        }
        return (int) $idRaw;
    }
}
