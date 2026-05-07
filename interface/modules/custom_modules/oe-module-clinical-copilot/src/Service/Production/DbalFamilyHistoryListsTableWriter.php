<?php

/**
 * Production wiring for {@see FamilyHistoryListsTableWriter}: writes
 * through Doctrine DBAL into OpenEMR's `lists` table for a
 * family-history-typed row.
 *
 * Single-table writer: a family-history entry is one row in `lists`
 * with `type='family_history'`, `pid`, `title` (the composite
 * `"{relation} — {condition}"`), and `comments` for any extracted
 * notes. No transaction needed for a single insert; the idempotency
 * check is a SELECT-then-INSERT pattern with a uniqueness contract
 * enforced at the application layer (the service is the only writer
 * of `(source_document_uuid, lower(trim(title)))` for the
 * family-history type).
 *
 * Row-id minting: `lists.id` is `bigint AUTO_INCREMENT`; we read it
 * back via `lastInsertId()` after the insert. The UUID is minted up
 * front and stored as `BINARY(16)` per OpenEMR's convention so the
 * post-insert event carries it without a follow-up read.
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
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryListsTableWriter;
use OpenEMR\Modules\ClinicalCopilot\Service\FamilyHistoryPromotionRequest;
use OpenEMR\Modules\ClinicalCopilot\Service\PersistedListEntry;
use Ramsey\Uuid\Uuid;

final readonly class DbalFamilyHistoryListsTableWriter implements FamilyHistoryListsTableWriter
{
    private const LIST_TYPE = 'family_history';

    public function __construct(private Connection $connection)
    {
    }

    public function findExistingFamilyHistory(
        string $sourceDocumentUuid,
        string $normalizedTitle,
    ): ?PersistedListEntry {
        // Match on the same normalization the caller used: lower +
        // trim of `lists.title`. Using LOWER(TRIM(title)) on both
        // sides keeps the lookup correct even if a previous writer
        // stored the title with mixed case or trailing whitespace.
        $sql = <<<'SQL'
            SELECT id, uuid
            FROM lists
            WHERE source_document_uuid = ?
              AND type = ?
              AND LOWER(TRIM(title)) = ?
            ORDER BY id ASC
            LIMIT 1
        SQL;

        $row = $this->connection->fetchAssociative(
            $sql,
            [$sourceDocumentUuid, self::LIST_TYPE, $normalizedTitle],
        );
        if ($row === false) {
            return null;
        }

        $rowIdRaw = $row['id'];
        if (!is_int($rowIdRaw) && !(is_string($rowIdRaw) && ctype_digit($rowIdRaw))) {
            throw new \RuntimeException('lists.id is not an integer value');
        }
        $listRowId = (int) $rowIdRaw;

        $uuidBin = $row['uuid'];
        if (!is_string($uuidBin) || strlen($uuidBin) !== 16) {
            throw new \RuntimeException('lists.uuid is not a 16-byte BINARY value');
        }
        $listUuid = Uuid::fromBytes($uuidBin)->toString();

        return new PersistedListEntry(listUuid: $listUuid, listRowId: $listRowId);
    }

    public function insertFamilyHistory(
        FamilyHistoryPromotionRequest $request,
        \DateTimeImmutable $createdAt,
    ): PersistedListEntry {
        $listUuid = Uuid::uuid4();
        $createdAtSql = $createdAt->format('Y-m-d H:i:s');

        $this->connection->insert('lists', [
            'uuid' => $listUuid->getBytes(),
            'type' => self::LIST_TYPE,
            // Composite "{relation} — {condition}" — the same form
            // the chart's family-history widget already renders.
            'title' => $request->title(),
            'pid' => $request->pid,
            'date' => $createdAtSql,
            'activity' => 1,
            // `lists` schema declares `comments` as longtext NULL and
            // `begdate` as datetime NULL. Pass through what the agent
            // supplied; let DEFAULTs handle the rest. `begdate` is
            // populated only when the agent supplied an `ageOfOnset`
            // (today the intake-form schema has no field for that, so
            // it'll typically be null until the schema gains one).
            'comments' => $request->comments,
            'begdate' => $request->ageOfOnset,
            'source_document_uuid' => $request->sourceDocumentUuid,
            'user' => (string) $request->promotedByUserId,
        ]);

        // Doctrine declares `lastInsertId(): string|int` in this DBAL
        // version. Narrow the string variant to "numeric string" so an
        // unexpected non-digit value (which would silently coerce to 0
        // in `(int)$x`) becomes a typed runtime failure instead.
        $insertedIdRaw = $this->connection->lastInsertId();
        if (is_string($insertedIdRaw) && !ctype_digit($insertedIdRaw)) {
            throw new \RuntimeException('lists.lastInsertId is not numeric');
        }
        $listRowId = (int) $insertedIdRaw;

        return new PersistedListEntry(
            listUuid: $listUuid->toString(),
            listRowId: $listRowId,
        );
    }
}
