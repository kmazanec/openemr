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
    private const LEAF_CATEGORY_NAME_REFERRAL = 'Referral Letter';

    public function __construct(private Connection $connection)
    {
    }

    public function ensureCategory(string $docType): int
    {
        $rootId = $this->findOrCreateCategory(self::ROOT_CATEGORY_NAME, parentId: 1);
        $leafName = match ($docType) {
            DocumentReferenceWriteService::DOC_TYPE_LAB_PDF => self::LEAF_CATEGORY_NAME_LAB,
            DocumentReferenceWriteService::DOC_TYPE_INTAKE_FORM => self::LEAF_CATEGORY_NAME_INTAKE,
            DocumentReferenceWriteService::DOC_TYPE_REFERRAL_LETTER => self::LEAF_CATEGORY_NAME_REFERRAL,
            default => throw new \DomainException("ensureCategory: unknown docType '{$docType}'"),
        };
        return $this->findOrCreateCategory($leafName, parentId: $rootId);
    }

    public function insertDocumentReferenceRow(
        int $pid,
        string $uuidBinary,
        string $url,
        string $mimeType,
        string $filename,
        string $hash,
        int $size,
        \DateTimeImmutable $createdAt,
        int $categoryId,
    ): int {
        // OpenEMR's `documents.id` is `int NOT NULL DEFAULT 0` — same
        // non-AUTO_INCREMENT pattern as `categories.id`. Mint the id
        // from the `sequences` helper table (the canonical OpenEMR
        // pattern) before the INSERT so we don't depend on
        // `lastInsertId()` returning anything meaningful afterwards.
        // Sequence minting is outside the transaction because it's
        // already atomic on its own (LAST_INSERT_ID(id+1)) and a
        // rollback wouldn't reclaim the id anyway.
        $documentRowId = $this->generateSequenceId();

        $this->connection->beginTransaction();
        try {
            $this->connection->insert('documents', [
                'id' => $documentRowId,
                'uuid' => $uuidBinary,
                // Local-disk row matches legacy uploads — the
                // Documents-tab viewer expects `file_url` + `path_depth`
                // to walk the URL backwards into
                // `OE_SITE_DIR/documents/<pid>/<filename>`.
                'type' => 'file_url',
                'url' => $url,
                'mimetype' => $mimeType,
                'name' => $filename,
                'hash' => $hash,
                'size' => $size,
                'path_depth' => 1,
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

    public function findRowIdByUuid(string $uuidBinary): ?int
    {
        $existing = $this->connection->fetchOne(
            'SELECT id FROM documents WHERE uuid = ? AND deleted = 0',
            [$uuidBinary],
        );
        return is_numeric($existing) ? (int) $existing : null;
    }

    public function findRowByUuid(string $uuidBinary): ?array
    {
        $row = $this->connection->fetchAssociative(
            'SELECT d.id AS row_id, d.foreign_id AS pid, c.name AS category_name '
            . 'FROM documents d '
            . 'LEFT JOIN categories_to_documents c2d ON c2d.document_id = d.id '
            . 'LEFT JOIN categories c ON c.id = c2d.category_id '
            . 'WHERE d.uuid = ? AND d.deleted = 0 '
            . 'LIMIT 1',
            [$uuidBinary],
        );
        if ($row === false) {
            return null;
        }

        $rowIdRaw = $row['row_id'] ?? null;
        $pidRaw = $row['pid'] ?? null;
        if (!is_numeric($rowIdRaw) || !is_numeric($pidRaw)) {
            return null;
        }

        $categoryName = $row['category_name'] ?? null;
        $docType = match ($categoryName) {
            self::LEAF_CATEGORY_NAME_LAB => DocumentReferenceWriteService::DOC_TYPE_LAB_PDF,
            self::LEAF_CATEGORY_NAME_INTAKE => DocumentReferenceWriteService::DOC_TYPE_INTAKE_FORM,
            self::LEAF_CATEGORY_NAME_REFERRAL => DocumentReferenceWriteService::DOC_TYPE_REFERRAL_LETTER,
            default => '',
        };

        return [
            'rowId' => (int) $rowIdRaw,
            'pid' => (int) $pidRaw,
            'docType' => $docType,
        ];
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
     *
     * The `sequences` table is a single-row counter (not AUTO_INCREMENT).
     * The atomic `UPDATE sequences SET id = LAST_INSERT_ID(id + 1)` is
     * the canonical MySQL pattern: `LAST_INSERT_ID(expr)` sets the
     * connection-local last-insert-id to `expr` AND returns it, so
     * `lastInsertId()` afterwards returns the freshly minted value
     * without a separate read-back. Mirrors ADOdb's mysqli driver
     * `_genIDSQL`.
     */
    private function generateSequenceId(): int
    {
        $this->connection->executeStatement(
            'UPDATE sequences SET id = LAST_INSERT_ID(id + 1)',
        );
        $idRaw = $this->connection->lastInsertId();
        if (!is_numeric($idRaw) || (int) $idRaw <= 0) {
            throw new \RuntimeException('sequences update did not return a generated id');
        }
        return (int) $idRaw;
    }
}
